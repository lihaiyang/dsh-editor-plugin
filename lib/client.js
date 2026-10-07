/**
 * dsh-editor-plugin —— Client 半边（浏览器）。
 *
 * 在现有侧边栏的文档预览工具栏（`sidebar.right.tab.document.actions` 槽位，
 * 与「打开方式」等控件同一行）加一个「编辑」按钮；点击后把编辑器**原位**
 * 覆盖到该预览的正文区上（`[data-textpreview-body]`），文件路径行与工具栏
 * 保留。编辑器提供：显式保存（Ctrl+S）、脏标记、从磁盘重载、Esc/按钮关闭、
 * 保存冲突检测（磁盘上的文件已改动时保存被拒并提示重载）。
 *
 * 写回走 Host 半边注册的 `/dsh-editor/file` 路由（与 open-in-app 同一套
 * connection 信任栅栏），不经任何第三方中转。
 *
 * 本文件是免构建的 `window.__ModuleLoader__.load({ id, factory })` CJS 包，
 * 只 require 基线外部模块：`react`、`react/jsx-runtime`、`react-dom`。
 */
window.__ModuleLoader__.load({
	id: "dsh-editor-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let react_dom = require("react-dom");

		//#region lib/client/shared.js
		/** 与 Host 半边约定一致的文档相对路由。 */
		const FILE_ROUTE = "dsh-editor/file";
		/** 客户端插件的稳定名字。 */
		const PLUGIN_ID = "dsh-editor-plugin";
		/** CSS 注入的标签标识（与内置包同款 data-plugin-css 约定）。 */
		const CSS_TAG_ID = "dsh-editor-plugin/client.css";
		/** 必需的 Cordis 服务：槽位注册表与文案。 */
		const inject = ["slots", "locale"];
		//#endregion

		//#region lib/client/locales.js
		const zh = {
			"edit": "编辑此文件",
			"title": "侧边栏编辑器",
			"save": "保存",
			"save.busy": "保存中…",
			"saved": "已保存",
			"reload": "从磁盘重载",
			"close": "关闭编辑器",
			"close.dirty": "有未保存的修改，确定放弃并关闭吗？",
			"reload.dirty": "有未保存的修改，确定放弃并从磁盘重载吗？",
			"dirty.aria": "有未保存的修改",
			"loading": "正在读取文件…",
			"error.read": "读取失败",
			"error.save": "保存失败",
			"error.stale": "文件在磁盘上已被修改，保存被拒绝。",
			"error.stale.fix": "请先从磁盘重载。",
			"hint.save": "Ctrl+S 保存 · Esc 关闭"
		};
		const en = {
			"edit": "Edit this file",
			"title": "Sidebar editor",
			"save": "Save",
			"save.busy": "Saving…",
			"saved": "Saved",
			"reload": "Reload from disk",
			"close": "Close editor",
			"close.dirty": "Discard unsaved changes and close?",
			"reload.dirty": "Discard unsaved changes and reload from disk?",
			"dirty.aria": "Unsaved changes",
			"loading": "Reading file…",
			"error.read": "Could not read the file",
			"error.save": "Could not save the file",
			"error.stale": "The file changed on disk; the save was rejected.",
			"error.stale.fix": "Reload from disk first.",
			"hint.save": "Ctrl+S to save · Esc to close"
		};
		//#endregion

		//#region lib/client/text-gate.js
		/** 视作可编辑文本的扩展名（小写，无点）。 */
		const TEXT_SUFFIXES = new Set([
			"md", "markdown", "mdx", "txt", "text", "log", "rst", "adoc",
			"json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
			"xml", "svg", "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl",
			"js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
			"py", "pyi", "pyw", "rb", "go", "rs", "java", "kt", "kts", "scala", "groovy",
			"c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "m", "mm",
			"php", "sh", "bash", "zsh", "fish", "ps1", "psm1", "psd1", "bat", "cmd",
			"sql", "graphql", "gql", "proto", "vue", "svelte", "astro",
			"swift", "dart", "lua", "pl", "pm", "r", "jl", "ex", "exs", "erl", "hrl",
			"hs", "elm", "clj", "cljs", "edn", "cmake", "mk", "gradle", "ipynb"
		]);
		/** 无扩展名也按文本处理的常见文件名。 */
		const TEXT_NAMES = new Set([
			"makefile", "dockerfile", "license", "licence", "readme", "changelog",
			"notice", "authors", "contributors", "codeowners",
			"gitignore", "gitattributes", "editorconfig", "npmrc", "nvmrc",
			"babelrc", "prettierrc", "eslintrc"
		]);
		/**
		 * 这个路径是否值得提供编辑按钮。宽进严出：不认识的扩展名不放行，
		 * 由 Host 的 `not-text` 拒绝兜底。
		 * @param path - 绝对路径或文件名。
		 * @returns 是否按文本文档处理。
		 */
		function isTextLike(path) {
			if (typeof path !== "string" || path === "") return false;
			const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
			const lower = name.toLowerCase();
			const dot = lower.lastIndexOf(".");
			if (dot < 0) return TEXT_NAMES.has(lower);
			if (dot === 0) return true; /* `.gitignore` 这类点文件按文本处理 */
			return TEXT_SUFFIXES.has(lower.slice(dot + 1));
		}
		//#endregion

		//#region lib/client/css.js
		/** 编辑器与工具按钮的样式；一次性注入 `<head>`。 */
		const CSS_TEXT = `
.dshEd_tool{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.72;flex:none}
.dshEd_tool:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
.dshEd_tool[aria-pressed="true"]{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent)}
.dshEd_overlay{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;min-height:0;color:inherit}
.dshEd_bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent);flex:none}
.dshEd_name{font-size:11.5px;line-height:1.3;opacity:.66;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dshEd_dot{width:7px;height:7px;border-radius:50%;background:#e0a52e;flex:none}
.dshEd_space{flex:1}
.dshEd_btn{appearance:none;border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;border-radius:7px;padding:3px 10px;font-size:12px;line-height:1.5;cursor:pointer;white-space:nowrap;flex:none}
.dshEd_btn:hover:not([disabled]){background:color-mix(in srgb,currentColor 10%,transparent)}
.dshEd_btn[disabled]{opacity:.45;cursor:default}
.dshEd_btn_primary{border-color:transparent;background:color-mix(in srgb,currentColor 14%,transparent);font-weight:600}
.dshEd_btn_primary:disabled{background:color-mix(in srgb,currentColor 8%,transparent)}
.dshEd_status{font-size:11.5px;line-height:1.4;padding:4px 10px;flex:none}
.dshEd_status_error{color:#e05252}
.dshEd_status_ok{opacity:.6}
.dshEd_area{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;outline:none;margin:0;padding:10px 12px;background:transparent;color:inherit;font:12.5px/1.65 ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,Menlo,monospace;white-space:pre;overflow:auto;tab-size:4}
.dshEd_hint{font-size:11px;line-height:1.4;opacity:.5;padding:4px 10px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);flex:none;user-select:none}
`;
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region lib/client/api.js
		/** 把一次失败的网络响应塑形成可读的 Error。 */
		function failureOf(response, payload) {
			const error = new Error(String(payload?.message ?? response.statusText));
			error.code = String(payload?.code ?? "http-" + response.status);
			error.status = response.status;
			return error;
		}
		/**
		 * 读取一个文本文件的全文与其版本令牌。
		 * @param path - 文件绝对路径（预览工具栏提供的执行环境路径）。
		 * @param signal - 取消读取。
		 * @returns 全文与版本令牌。
		 */
		async function readFile(path, signal) {
			const response = await fetch(FILE_ROUTE + "?path=" + encodeURIComponent(path), {
				signal,
				headers: { accept: "application/json" }
			});
			const payload = await response.json().catch(() => void 0);
			if (!response.ok) throw failureOf(response, payload);
			if (typeof payload?.text !== "string") throw Object.assign(new Error("malformed read response"), { code: "bad-payload" });
			return { text: payload.text, version: String(payload.version ?? "") };
		}
		/**
		 * 把编辑后的全文写回磁盘。
		 * @param path - 文件绝对路径。
		 * @param text - 全文。
		 * @param version - 读取时观察到的版本令牌；空串表示不设前置条件。
		 * @returns 写回后的版本令牌。
		 */
		async function writeFile(path, text, version) {
			const response = await fetch(FILE_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path, text, ...(version === "" ? {} : { version }) })
			});
			const payload = await response.json().catch(() => void 0);
			if (!response.ok) throw failureOf(response, payload);
			return String(payload?.version ?? "");
		}
		//#endregion

		//#region lib/client/overlay.js
		/**
		 * 从工具按钮向上找到本预览的正文元素。
		 * @param from - 按钮元素。
		 * @returns 正文元素与其承载根，找不到时为 undefined。
		 */
		function findPreviewBody(from) {
			let node = from?.parentElement ?? null;
			while (node !== null && node !== document.body) {
				const body = node.querySelector("[data-textpreview-body]");
				if (body !== null) return { root: node, body };
				node = node.parentElement;
			}
			return void 0;
		}
		/**
		 * 取一个不透明底色：沿祖先找第一个非透明的背景色，保证编辑器盖住预览。
		 * @param element - 起点元素。
		 * @returns CSS 颜色值。
		 */
		function opaqueBackgroundOf(element) {
			let node = element;
			while (node !== null && node !== document.documentElement) {
				const color = getComputedStyle(node).backgroundColor;
				if (color !== "" && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
				node = node.parentElement;
			}
			return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true ? "#1f1f1f" : "#ffffff";
		}
		//#endregion

		//#region lib/client/EditorPanel.js
		/** 面板生命周期：loading → ready ⇄ saving → saved / error。 */
		/**
		 * 原位编辑面板：覆盖预览正文区的全文编辑器。
		 * @param props - 文件路径、文案、关闭回调。
		 * @returns 面板。
		 */
		function EditorPanel(props) {
			const { path, t, onClose } = props;
			const areaRef = (0, react.useRef)(null);
			const originalRef = (0, react.useRef)("");
			const versionRef = (0, react.useRef)("");
			const savingRef = (0, react.useRef)(false);
			const [draft, setDraft] = (0, react.useState)("");
			const [status, setStatus] = (0, react.useState)("loading");
			const [message, setMessage] = (0, react.useState)("");
			const [savedTick, setSavedTick] = (0, react.useState)(false);
			const [background, setBackground] = (0, react.useState)(void 0);
			const dirty = status === "ready" && draft !== originalRef.current;

			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setStatus("loading");
				readFile(path, controller.signal).then((result) => {
					originalRef.current = result.text;
					versionRef.current = result.version;
					setDraft(result.text);
					setStatus("ready");
					areaRef.current?.focus();
				}, (error) => {
					if (controller.signal.aborted) return;
					setStatus("error");
					setMessage(error?.code === "not-text"
						? t("error.read") + " — not text"
						: t("error.read") + " — " + String(error?.message ?? error));
				});
				return () => controller.abort();
			}, [path, t]);

			(0, react.useEffect)(() => {
				const host = areaRef.current?.parentElement;
				if (host === void 0 || host === null) return;
				setBackground(opaqueBackgroundOf(host));
			}, []);

			const save = (0, react.useCallback)(() => {
				if (savingRef.current || status !== "ready") return;
				if (draft === originalRef.current) return;
				savingRef.current = true;
				setStatus("saving");
				setMessage("");
				writeFile(path, draft, versionRef.current).then((version) => {
					originalRef.current = draft;
					versionRef.current = version;
					setStatus("ready");
					setSavedTick(true);
				}, (error) => {
					setStatus("ready");
					if (error?.code === "stale") {
						versionRef.current = "";
						setMessage(t("error.stale") + " " + t("error.stale.fix"));
					} else {
						setMessage(t("error.save") + " — " + String(error?.message ?? error));
					}
				}).finally(() => {
					savingRef.current = false;
				});
			}, [draft, path, status, t]);

			(0, react.useEffect)(() => {
				if (!savedTick) return;
				const timer = window.setTimeout(() => setSavedTick(false), 2000);
				return () => window.clearTimeout(timer);
			}, [savedTick]);

			const confirmDiscard = (0, react.useCallback)((question) => dirty === false || window.confirm(question), [dirty]);

			const close = (0, react.useCallback)(() => {
				if (confirmDiscard(t("close.dirty"))) onClose();
			}, [confirmDiscard, onClose, t]);

			const reload = (0, react.useCallback)(() => {
				if (!confirmDiscard(t("reload.dirty"))) return;
				const controller = new AbortController();
				setStatus("loading");
				readFile(path, controller.signal).then((result) => {
					originalRef.current = result.text;
					versionRef.current = result.version;
					setDraft(result.text);
					setStatus("ready");
					setMessage("");
					areaRef.current?.focus();
				}, (error) => {
					setStatus("error");
					setMessage(t("error.read") + " — " + String(error?.message ?? error));
				});
			}, [path, t]);

			const onKeyDown = (0, react.useCallback)((event) => {
				if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === "s") {
					event.preventDefault();
					save();
					return;
				}
				if (event.key === "Escape") {
					event.stopPropagation();
					close();
				}
			}, [close, save]);

			const fileName = path.replace(/\\/g, "/").split("/").pop() ?? path;
			const busy = status === "saving";
			const blocked = status !== "ready";
			const statusLine = status === "loading" ? { text: t("loading"), tone: "plain" }
				: message !== "" ? { text: message, tone: "error" }
				: savedTick ? { text: t("saved"), tone: "ok" }
				: void 0;

			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshEd_overlay",
				style: { background },
				"data-dsh-editor-panel": "",
				children: [
					(0, react_jsx_runtime.jsxs)("div", { className: "dshEd_bar", children: [
						dirty && (0, react_jsx_runtime.jsx)("span", { className: "dshEd_dot", role: "img", "aria-label": t("dirty.aria"), title: t("dirty.aria") }),
						(0, react_jsx_runtime.jsx)("span", { className: "dshEd_name", title: path, children: fileName }),
						(0, react_jsx_runtime.jsx)("span", { className: "dshEd_space" }),
						(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshEd_btn dshEd_btn_primary",
							disabled: blocked || !dirty || busy,
							onClick: save,
							children: busy ? t("save.busy") : t("save")
						}),
						(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshEd_btn",
							disabled: busy,
							title: t("reload"),
							"aria-label": t("reload"),
							onClick: reload,
							children: "⟳"
						}),
						(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dshEd_btn",
							disabled: busy,
							title: t("close"),
							"aria-label": t("close"),
							onClick: close,
							children: "✕"
						})
					] }),
					statusLine !== void 0 && (0, react_jsx_runtime.jsx)("div", {
						className: statusLine.tone === "error" ? "dshEd_status dshEd_status_error" : "dshEd_status dshEd_status_ok",
						role: "status",
						children: statusLine.text
					}),
					(0, react_jsx_runtime.jsx)("textarea", {
						ref: areaRef,
						className: "dshEd_area",
						spellCheck: false,
						wrap: "off",
						value: draft,
						disabled: blocked,
						readOnly: blocked,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: onKeyDown,
						"aria-label": t("title")
					}),
					(0, react_jsx_runtime.jsx)("div", { className: "dshEd_hint", children: t("hint.save") })
				]
			});
		}
		//#endregion

		//#region lib/client/EditAction.js
		/** 内联铅笔图标（16px，stroke: currentColor）。 */
		function PencilIcon() {
			return (0, react_jsx_runtime.jsx)("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true,
				children: (0, react_jsx_runtime.jsx)("path", {
					d: "M11.3 2.1a1.6 1.6 0 0 1 2.26 0l.34.34a1.6 1.6 0 0 1 0 2.26l-7.4 7.4-3.3.86.86-3.3 7.4-7.4Z",
					stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round"
				})
			});
		}
		/**
		 * 文档预览工具栏里的「编辑」按钮：把编辑器原位覆盖到本预览的正文区。
		 * @param props - 槽位 owner（`absolutePath`）与注入的文案。
		 * @returns 按钮与（激活时的）编辑器门户。
		 */
		function EditAction(props) {
			const { absolutePath, t } = props;
			const anchorRef = (0, react.useRef)(null);
			const hostRef = (0, react.useRef)(void 0);
			const [editing, setEditing] = (0, react.useState)(false);

			if (!isTextLike(absolutePath)) return null;

			const found = editing && hostRef.current !== void 0 ? hostRef.current : void 0;

			(0, react.useEffect)(() => {
				if (found === void 0) return;
				const body = found.body;
				const previous = body.style.position;
				if (getComputedStyle(body).position === "static") body.style.position = "relative";
				return () => {
					body.style.position = previous;
				};
			}, [found]);

			const open = (0, react.useCallback)(() => {
				const located = findPreviewBody(anchorRef.current);
				if (located === void 0) return;
				hostRef.current = located;
				setEditing(true);
			}, []);

			const close = (0, react.useCallback)(() => {
				hostRef.current = void 0;
				setEditing(false);
			}, []);

			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				(0, react_jsx_runtime.jsx)("button", {
					ref: anchorRef,
					type: "button",
					className: "dshEd_tool",
					title: t("edit"),
					"aria-label": t("edit"),
					"aria-pressed": editing,
					"data-dsh-editor-tool": editing ? "editing" : "idle",
					onClick: editing ? close : open,
					children: (0, react_jsx_runtime.jsx)(PencilIcon, {})
				}),
				found !== void 0 && (0, react_dom.createPortal)(
					(0, react_jsx_runtime.jsx)(EditorPanel, {
						path: absolutePath,
						t,
						onClose: close
					}),
					found.body,
					"dsh-editor-overlay"
				)
			] });
		}
		//#endregion

		//#region lib/client/index.js
		/** 文案命名空间。 */
		const NS = "sidebarTextEditor";
		/**
		 * Client 插件体：注册文案，并把「编辑」按钮注入现有文档预览的工具栏槽位。
		 * @param ctx - client root context（携带 slots 与 locale）。
		 */
		function apply(ctx) {
			injectCss();
			const tRef = { current: void 0 };
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-editor: dictionaries");
			tRef.current = ctx.locale.bind(NS);
			ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document.actions", () => ctx.slots.register({
				name: "sidebar.right.tab.document.actions",
				id: "dsh-editor",
				inject: () => ({ t: tRef.current })
			}, EditAction)), "dsh-editor: document toolbar edit action");
		}
		//#endregion

		exports.name = "dsh-editor";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
