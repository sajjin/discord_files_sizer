/**
 * @name FileRedirectUpload
 * @description Redirects drag-and-dropped Discord attachments to your external server, then pastes or sends the returned link automatically.
 * @version 1.0.0
 * @author Sajjin Nijjar
 * @authorLink https://github.com/sajjin/discord_files_sizer
 * @source https://github.com/sajjin/discord_files_sizer/tree/main
 * @updateUrl https://raw.githubusercontent.com/sajjin/discord_files_sizer/main/FileRedirectUpload.plugin.js
 */

module.exports = class FileRedirectUpload {
	constructor() {
		this.meta = {
			name: "FileRedirectUpload",
			authors: [{ name: "Sajjin Nijjar" }],
			description: "Redirects drag-and-dropped Discord attachments to your external server, then pastes or sends the returned link automatically.",
			version: "1.0.0"
		};

		this.defaultSettings = {
			serverUrl: "https://",
			apiKey: "",
			autoSend: true,
			copyToClipboard: true,
			chunkSize: 50 * 1024 * 1024,
			maxDirectSize: 100 * 1024 * 1024
		};

		this.settings = this.loadSettings();
		this.onDrop = this.onDrop.bind(this);
		this.onDragOver = this.onDragOver.bind(this);
	}

	getName() { return this.meta.name; }
	getAuthor() { return this.meta.authors.map(a => a.name).join(", "); }
	getDescription() { return this.meta.description; }
	getVersion() { return this.meta.version; }

	start() {
		try {
			this.settings = this.loadSettings();
			this.messageActions = BdApi.Webpack.getModule(m => m?.sendMessage && m?.editMessage);
			this.channelStore = BdApi.Webpack.getModule(m => m?.getLastSelectedChannelId && m?.getChannelId);
			this.userStore = BdApi.Webpack.getModule(m => m?.getCurrentUser && typeof m.getCurrentUser === "function");

			document.addEventListener("dragover", this.onDragOver, true);
			document.addEventListener("drop", this.onDrop, true);

			BdApi.UI.showToast(`${this.meta.name} ready`, { type: "info" });
		} catch (err) {
			console.error(`[${this.meta.name}] Start error:`, err);
		}
	}

	stop() {
		document.removeEventListener("dragover", this.onDragOver, true);
		document.removeEventListener("drop", this.onDrop, true);
	}

	loadSettings() {
		try {
			if (BdApi.Data?.load) {
				const stored = BdApi.Data.load(this.meta.name, "settings");
				return { ...this.defaultSettings, ...(stored || {}) };
			}

			const stored = BdApi.loadData?.(this.meta.name, "settings");
			return { ...this.defaultSettings, ...(stored || {}) };
		} catch {
			return { ...this.defaultSettings };
		}
	}

	saveSettings() {
		try {
			if (BdApi.Data?.save) {
				BdApi.Data.save(this.meta.name, "settings", this.settings);
				return;
			}

			BdApi.saveData?.(this.meta.name, "settings", this.settings);
		} catch (err) {
			console.error(`[${this.meta.name}] Failed to save settings:`, err);
		}
	}

	getSettingsPanel() {
		const panel = document.createElement("div");
		panel.style.padding = "16px";

		const addTextInput = (label, key, type = "text") => {
			const wrap = document.createElement("div");
			wrap.style.marginBottom = "12px";
			const lbl = document.createElement("div");
			lbl.textContent = label;
			lbl.style.marginBottom = "4px";
			const input = document.createElement("input");
			input.type = type;
			input.style.width = "100%";
			input.value = this.settings[key];
			input.onchange = (e) => {
				const value = type === "number" ? Number(e.target.value) : e.target.value;
				this.settings[key] = value;
				this.saveSettings();
			};
			wrap.appendChild(lbl);
			wrap.appendChild(input);
			panel.appendChild(wrap);
		};

		const addToggle = (label, key) => {
			const wrap = document.createElement("div");
			wrap.style.marginBottom = "12px";
			const input = document.createElement("input");
			input.type = "checkbox";
			input.checked = this.settings[key];
			input.onchange = (e) => {
				this.settings[key] = e.target.checked;
				this.saveSettings();
			};
			const lbl = document.createElement("label");
			lbl.style.marginLeft = "6px";
			lbl.textContent = label;
			wrap.appendChild(input);
			wrap.appendChild(lbl);
			panel.appendChild(wrap);
		};

		addTextInput("Server URL (no trailing slash)", "serverUrl");
		addTextInput("API Key", "apiKey");
		addTextInput("Chunk size bytes (advanced)", "chunkSize", "number");
		addTextInput("Max direct upload bytes", "maxDirectSize", "number");
		addToggle("Auto-send link to channel", "autoSend");
		addToggle("Copy link to clipboard", "copyToClipboard");

		return panel;
	}

	onDragOver(event) {
		if (event.dataTransfer?.types?.includes("Files")) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	async onDrop(event) {
		if (!event.dataTransfer?.files?.length) return;

		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();

		const files = Array.from(event.dataTransfer.files);
		const channelId = this.channelStore?.getLastSelectedChannelId?.();

		for (const file of files) {
			try {
				BdApi.UI.showToast(`Uploading ${file.name}...`, { type: "info" });
				const uploadResult = await this.uploadFile(file);
				if (!uploadResult) continue;

				const formattedMessage = this.buildBotStyleMessage(uploadResult);
				const clipboardText = uploadResult.youtubeLink || formattedMessage;
				console.log(`[${this.meta.name}] Uploaded ${file.name}:`, uploadResult);

				if (this.settings.copyToClipboard) {
					DiscordNative.clipboard.copy(clipboardText);
					BdApi.UI.showToast(
						uploadResult.youtubeLink
							? "YouTube link copied to clipboard!"
							: "Preview + full links copied to clipboard!",
						{ type: "success" }
					);
				}

				if (this.settings.autoSend && channelId && this.messageActions?.sendMessage) {
					this.messageActions.sendMessage(channelId, { content: formattedMessage }, {});
				} else {
					this.insertIntoComposer(formattedMessage);
				}

				BdApi.UI.showToast(`Uploaded ${file.name}`, { type: "success" });
			} catch (err) {
				console.error(`[${this.meta.name}] Upload failed:`, err);
				BdApi.UI.showToast(`Upload failed: ${file.name}`, { type: "error" });
			}
		}
	}

	insertIntoComposer(text) {
		const textarea = document.querySelector("textarea");
		if (!textarea) return;

		const start = textarea.selectionStart;
		const end = textarea.selectionEnd;
		const value = textarea.value;
		textarea.value = value.slice(0, start) + text + value.slice(end);
		textarea.selectionStart = textarea.selectionEnd = start + text.length;
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}

	async uploadFile(file) {
		const server = this.settings.serverUrl.replace(/\/$/, "");
		const apiKey = this.settings.apiKey;
		const chunkSize = Number(this.settings.chunkSize) || this.defaultSettings.chunkSize;
		const uploaderName = this.getUploaderName();

		if (!server || !apiKey) throw new Error("Server URL or API key missing");

		return this.chunkedUpload(server, apiKey, file, chunkSize, uploaderName);
	}

	getUploaderName() {
		const user = this.userStore?.getCurrentUser?.();
		if (!user) return "Plugin Upload";

		if (user.discriminator && user.discriminator !== "0") {
			return `${user.username}#${user.discriminator}`;
		}

		return user.globalName || user.username || "Plugin Upload";
	}

	buildBotStyleMessage(uploadResult) {
		const lines = [];

		if (uploadResult.uploaderName) {
			lines.push(`**Uploaded by:** ${uploadResult.uploaderName}`);
		}

		if (uploadResult.youtubeLink) {
			lines.push("Watch on YouTube:");
			lines.push(uploadResult.youtubeLink);
			return lines.join("\n");
		}

		if (uploadResult.previewLink) {
			lines.push("This is a preview:");
			lines.push(uploadResult.previewLink);
		}

		if (uploadResult.fullLink) {
			lines.push("Full version:");
			lines.push(uploadResult.fullLink);
		}

		return lines.join("\n");
	}

	normalizeUploadResult(uploadData) {
		const uploaderName = uploadData.uploaderName || uploadData.username || "";
		const youtubeLink =
			uploadData.youtubeUrl ||
			uploadData.watchUrl ||
			(this.isYouTubeUrl(uploadData.url) ? uploadData.url : "") ||
			(this.isYouTubeUrl(uploadData.fileUrl) ? uploadData.fileUrl : "") ||
			(this.isYouTubeUrl(uploadData.previewUrl) ? uploadData.previewUrl : "");

		if (youtubeLink) {
			return { previewLink: youtubeLink, fullLink: youtubeLink, youtubeLink, uploaderName };
		}

		const previewLink = uploadData.url || uploadData.previewUrl || uploadData.fileUrl || "";
		const fullLink = uploadData.fileUrl || uploadData.url || uploadData.previewUrl || "";

		if (!previewLink && !fullLink) {
			throw new Error("No URL returned from server");
		}

		return { previewLink, fullLink, uploaderName };
	}

	isYouTubeUrl(value) {
		if (!value || typeof value !== "string") return false;
		return /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)/i.test(value);
	}

	async directUpload(server, apiKey, file, uploaderName) {
		const form = new FormData();
		form.append("file", file, file.name);
		form.append("uploaderName", uploaderName);
		const res = await fetch(`${server}/plugin-upload`, {
			method: "POST",
			headers: { "X-API-Key": apiKey },
			body: form
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Direct upload failed: ${res.status} - ${text}`);
		}
		const data = await res.json();
		if (!data.success) throw new Error(data.error || "Unknown error");
		return this.normalizeUploadResult(data);
	}

	async chunkedUpload(server, apiKey, file, chunkSize, uploaderName) {
		const initRes = await fetch(`${server}/plugin-upload/init`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": apiKey
			},
			body: JSON.stringify({
				fileName: file.name,
				fileSize: file.size,
				totalChunks: Math.ceil(file.size / chunkSize),
				uploaderName
			})
		});
		if (!initRes.ok) throw new Error(`Init failed: ${initRes.status}`);
		const initData = await initRes.json();
		if (!initData.success || !initData.uploadId) throw new Error(initData.error || "Init error");

		const uploadId = initData.uploadId;
		const serverChunkSize = initData.chunkSize || chunkSize;
		const totalChunks = Math.ceil(file.size / serverChunkSize);

		for (let i = 0; i < totalChunks; i++) {
			const start = i * serverChunkSize;
			const end = Math.min(start + serverChunkSize, file.size);
			const blob = file.slice(start, end);
			const form = new FormData();
			form.append("chunk", blob, file.name);

			console.log(`[${this.meta.name}] Chunk ${i + 1}/${totalChunks}: bytes ${start}-${end} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
			BdApi.UI.showToast(`Uploading ${file.name}: chunk ${i + 1}/${totalChunks} (${Math.round(((i + 1) / totalChunks) * 100)}%)`, { type: "info" });

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 300000);

			try {
				const res = await fetch(`${server}/plugin-upload/chunk`, {
					method: "POST",
					headers: {
						"X-API-Key": apiKey,
						"X-Upload-ID": uploadId,
						"X-Chunk-Index": String(i),
						"X-Total-Chunks": String(totalChunks)
					},
					body: form,
					signal: controller.signal
				});
				clearTimeout(timeout);
				console.log(`[${this.meta.name}] Chunk ${i + 1} response status:`, res.status);
				console.log(`[${this.meta.name}] Chunk ${i + 1} headers:`, {
					"content-type": res.headers.get("content-type"),
					"content-length": res.headers.get("content-length")
				});

				if (!res.ok) {
					const text = await res.text();
					console.error(`[${this.meta.name}] Chunk ${i + 1} error response:`, text);
					throw new Error(`Chunk ${i + 1} failed: ${res.status} - ${text}`);
				}

				const text = await res.text();
				console.log(`[${this.meta.name}] Chunk ${i + 1} raw response:`, text);

				const data = JSON.parse(text);
				console.log(`[${this.meta.name}] Chunk ${i + 1} parsed response:`, data);

				if (!data.success) {
					throw new Error(data.error || `Chunk ${i + 1} error`);
				}
			} catch (err) {
				clearTimeout(timeout);
				console.error(`[${this.meta.name}] Chunk ${i + 1} error:`, err);
				throw err;
			}
		}

		const finalizeRes = await fetch(`${server}/plugin-upload/finalize`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": apiKey
			},
			body: JSON.stringify({ uploadId })
		});
		if (!finalizeRes.ok) throw new Error(`Finalize failed: ${finalizeRes.status}`);
		const finalizeData = await finalizeRes.json();
		if (!finalizeData.success) throw new Error(finalizeData.error || "Finalize error");
		return this.normalizeUploadResult(finalizeData);
	}
};
