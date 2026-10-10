window.__ModuleLoader__.load({
	id: "dsh-plugin-opencode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region lib/client.js — OpenCode 上下文长度只读药丸
		// 与 dsh-plugin-workbuddy 的客户端半边同构（插件化显示）:本插件只消费自己
		// 的 /opencode/context-window 路由,注册自己的 dock 药丸。OpenCode 的目录对
		// 每个模型只报告一个固定窗口(session API 不接受上下文参数),所以面板是只读
		// 的:显示「当前选中的模型」的固定窗口,而不是把所有模型全列出来。当前模型
		// 不属于本提供商时整个入口不渲染。
		const TAG_ID = "dsh-plugin-opencode/ContextPicker.css";
		const css = ".wbc_anchor{position:relative;display:inline-flex;min-width:0;align-items:center}" +
			".wbc_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;" +
			"border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);" +
			"font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer;max-width:100%}" +
			".wbc_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}" +
			".wbc_mark{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}" +
			".wbc_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
			".wbc_empty{color:var(--dsw-alias-label-tertiary);padding:10px 12px;line-height:18px}" +
			".wbc_panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);" +
			"z-index:9999;width:296px;max-height:min(60vh,420px);overflow-y:auto;overscroll-behavior:contain;" +
			"padding:6px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2);" +
			"background:var(--dsw-alias-bg-module-platform);box-shadow:0 6px 24px rgba(0,0,0,.18);" +
			"color:var(--dsw-alias-label-primary)}" +
			".wbc_title{padding:4px 8px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
			".wbc_row{display:flex;align-items:center;justify-content:space-between;gap:10px;" +
			"padding:5px 8px;border-radius:6px}" +
			".wbc_row[data-active=true]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover))}" +
			".wbc_name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
			"font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
			".wbc_fixed{font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;" +
			"color:var(--dsw-alias-label-tertiary);white-space:nowrap}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-opencode";
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** `1000000` -> `"1M"`, `300000` -> `"300K"`,与 WorkBuddy CLI 的显示一致。 */
		function formatLength(n) {
			const value = Number(n);
			if (!Number.isFinite(value)) return String(n);
			if (value >= 1e6 && value % 1e6 === 0) return value / 1e6 + "M";
			if (value >= 1e3 && value % 1e3 === 0) return value / 1e3 + "K";
			return String(value);
		}

		/**
		 * 这个对话当前选中的 {provider, model},编码成一个稳定的字符串 key;
		 * 拿不到时返回 null。快照保持原始值,避免宿主每次目录同步都重建对象导致
		 * uSES 无限重渲染。
		 */
		function readCurrentSelectionKey(directory) {
			if (!directory || typeof directory.getSnapshot !== "function") return null;
			const snapshot = directory.getSnapshot();
			const current = snapshot && snapshot.current;
			if (!current || typeof current.model !== "string" || current.model.length === 0) return null;
			const provider = typeof current.provider === "string" ? current.provider : "";
			return provider + "\u0000" + current.model;
		}

		/** 订阅当前对话的模型选择。换对话时宿主换掉 store,订阅跟着重建。 */
		function useCurrentSelectionKey(directory) {
			const subscribe = react.useCallback((notify) => {
				if (!directory || typeof directory.subscribe !== "function") return () => {};
				return directory.subscribe(notify);
			}, [directory]);
			const getSnapshot = react.useCallback(() => readCurrentSelectionKey(directory), [directory]);
			return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		/** 当前选择的提供商 id,或 null。 */
		function useCurrentProvider(directory) {
			const key = useCurrentSelectionKey(directory);
			if (key === null) return null;
			const split = key.indexOf("\u0000");
			return split === -1 ? null : key.slice(0, split);
		}

		/** 本插件的提供商路由 id。必须与 lib/index.js 的 Config.provider 一致。 */
		const OPENCODE_PROVIDER = "opencode-free";
		const PROVIDER_SOURCES = [
			{ url: "/opencode/context-window", fallbackName: "OpenCode Zen (Free)" },
		];

		/**
		 * 上下文长度只读药丸 —— 只服务 OpenCode 提供商。
		 *
		 * 药丸始终反映「当前选中的模型」的固定窗口。当前模型不是 OpenCode 模型、或
		 * 目录拿不到当前选择时,整个入口不渲染 —— 绝不把其他提供商的模型全列出来。
		 */
		const ContextPicker = react.memo(function ContextPicker(props) {
			// 当前对话选中的 {provider, model};取不到时为 null,此时不渲染。
			const currentKey = useCurrentSelectionKey(props != null ? props.directory : undefined);
			const currentProvider = useCurrentProvider(props != null ? props.directory : undefined);
			const isOpencode = currentProvider === OPENCODE_PROVIDER;
			const [state, setState] = react.useState({ open: false, groups: null, error: null });
			const rootRef = react.useRef(null);
			const inFlightRef = react.useRef(false);
			const mountedRef = react.useRef(false);

			const load = react.useCallback(() => {
				if (inFlightRef.current) return;
				inFlightRef.current = true;
				Promise.allSettled(PROVIDER_SOURCES.map((source) =>
					fetch(source.url, { headers: { accept: "application/json" }, cache: "no-store" })
						.then((res) => {
							if (!res.ok) throw new Error("HTTP " + res.status);
							return res.json();
						})
						.then((data) => ({ source, data })),
				))
					.then((settled) => {
						const groups = [];
						for (const entry of settled) {
							if (entry.status !== "fulfilled") continue;
							const { source, data } = entry.value;
							const models = Array.isArray(data && data.models) ? data.models : [];
							if (models.length === 0) continue;
							groups.push({
								key: typeof data.provider === "string" && data.provider.length > 0 ? data.provider : source.url,
								name: typeof data.providerName === "string" && data.providerName.length > 0
									? data.providerName
									: source.fallbackName,
								url: source.url,
								models,
							});
						}
						setState((prev) => (groups.length > 0
							? { ...prev, groups, error: null }
							: (prev.groups === null
								? { ...prev, error: "OpenCode 上下文目录读取失败" }
								: prev)));
					})
					.finally(() => { inFlightRef.current = false; });
			}, []);

			// 挂载即拉取一次:药丸的可见性与标签取决于当前模型是否命中目录。之后只在
			// 打开面板时补拉。
			react.useEffect(() => {
				if (!mountedRef.current) {
					mountedRef.current = true;
					load();
					return;
				}
				if (state.open && state.groups === null) load();
			}, [state.open, state.groups, load]);

			// 点击面板外部或按 Esc 关闭。
			react.useEffect(() => {
				if (!state.open) return undefined;
				const onPointerDown = (event) => {
					if (rootRef.current && !rootRef.current.contains(event.target)) {
						setState((prev) => ({ ...prev, open: false }));
					}
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setState((prev) => ({ ...prev, open: false }));
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [state.open]);

			// 当前选择 -> 要展示的分组与当前行。只有当前模型的提供商就是本插件、且
			// 模型命中本目录时才产出内容;任何其他情况返回 null,调用方据此整入口
			// 不渲染,不再退回列出全部模型。
			const view = state.groups === null ? null : (() => {
				if (currentKey === null || !isOpencode) return null;
				const split = currentKey.indexOf("\u0000");
				const provider = currentKey.slice(0, split);
				const model = currentKey.slice(split + 1);
				const group = provider.length > 0
					? state.groups.find((entry) => entry.key === provider)
					: undefined;
				const row = group !== undefined
					? group.models.find((entry) => entry.id === model)
					: undefined;
				return group !== undefined && row !== undefined
					? { groups: [group], active: row }
					: null;
			})();

			// 目录还没就绪、或当前模型不属于 OpenCode 时,整个入口不渲染。
			if (state.groups === null || view === null) return null;

			const row = view.active;
			const title = row.displayName || row.name || row.id;
			const label = row.effective != null ? formatLength(row.effective) : "上下文";

			return react.createElement("span", { className: "wbc_anchor", ref: rootRef },
				react.createElement("button", {
					className: "wbc_pill",
					type: "button",
					"aria-expanded": state.open,
					"aria-haspopup": "true",
					title: title + " 的上下文长度",
					onClick: () => setState((prev) => ({ ...prev, open: !prev.open })),
				},
					react.createElement("span", { className: "wbc_label" }, label),
				),
				state.open ? react.createElement("div", { className: "wbc_panel", role: "dialog", "aria-label": "上下文长度" },
					react.createElement("div", { className: "wbc_title" },
						title + " · 上下文长度（影响自动压缩时机）,OpenCode 为服务端固定值"),
					react.createElement("div", { className: "wbc_group" }, view.groups[0].name),
					react.createElement("div", {
						className: "wbc_row",
						"data-active": "true",
						title: title,
					},
						react.createElement("span", { className: "wbc_name" }, title),
						react.createElement("span", { className: "wbc_fixed" },
							row.effective != null ? formatLength(row.effective) : "—", " 固定"),
					),
					state.error !== null
						? react.createElement("div", { className: "wbc_empty" }, state.error)
						: null,
				) : null,
			);
		});
		//#endregion

		//#region 插件装配
		/** 这个会话当前模型的 `directory` store,拿不到返回 undefined。 */
		function modelDirectoryFor(models, sessionId) {
			if (!models || typeof models.directoryFor !== "function" || sessionId === undefined) {
				return undefined;
			}
			try {
				return models.directoryFor(sessionId);
			} catch {
				return undefined;
			}
		}

		/** Register the opencode context pill into the input box's dock. */
		function apply(ctx) {
			// 会话级注入:当前模型的 {provider, model}。只显示当前模型命中 OpenCode
			// 目录时的那一行;与 WorkBuddy 的药丸靠提供商互相排斥,同一时间只显一个。
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "opencode-context-window",
				order: 11,
				inject: (sessionId) => {
					const directory = modelDirectoryFor(ctx.get("modelDirectories"), sessionId);
					return directory === undefined ? {} : { directory: directory.store };
				},
			}, ContextPicker));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = ["slots"];
		exports.name = "opencode-context-window";
		return module.exports;
	}
});