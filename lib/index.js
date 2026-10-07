/**
 * dsh-editor-plugin —— Host 半边（Node / Cordis 函数插件）。
 *
 * 在组合的 `webServer` 上注册一个路由，供浏览器半边（lib/client.js）读写
 * 侧边栏正在预览的文本文档：
 *
 *   GET  /dsh-editor/file?path=<绝对路径>   → { path, version, text }
 *   POST /dsh-editor/file                   → { path, version }
 *        body: { path, text, version? }    // version 为读取时观察到的令牌
 *
 * 安全模型与 `dsh-host-open-in-app` 一致：每个请求先过 `connection`
 * 服务的 `requestRejection` 栅栏（Host/Origin 防线 + 浏览器登录鉴权），
 * 再做路径解析与读写。读写一律走组合的 `fs` 服务，因此与工具层同享
 * 沙箱/观测策略，而不是绕过它直接碰磁盘。带 `version` 的写回受
 * FS_STALE_VERSION 守卫：磁盘上的文件若已被人改动，保存以 409 拒绝。
 */

/** 路由路径（webServer 需要绝对 pathname；浏览器按文档相对形式访问）。 */
const FILE_PATH = "/dsh-editor/file";

/** 请求体上限：一次编辑的全文 JSON。超出即视为恶意请求。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 读取上限：超过此字节数的文件拒绝在侧边栏编辑。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Cordis 函数插件名。 */
export const name = "dsh-editor";

/** 必需服务：路由载体、信任栅栏、文件系统。 */
export const inject = ["webServer", "connection", "fs"];

/** 组合的 connection 服务（其类型声明在浏览器侧包里，这里本地取用）。 */
function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405;
	res.setHeader("allow", allow);
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify({ code: "method-not-allowed", message: `only ${allow} is supported` }));
}

/** 有界读体：超过上限直接拒绝，不缓冲恶意大包。 */
function readBoundedBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limit) {
				reject(Object.assign(new Error("request body too large"), { code: "too-large" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** 插件体：注册读、写两个路由。 */
export function apply(ctx) {
	const rejectRequest = (req, res) => {
		const connection = connectionOf(ctx);
		if (connection === void 0) return false;
		const rejection = connection.requestRejection(req);
		if (rejection === void 0) return false;
		res.statusCode = rejection;
		res.end();
		return true;
	};

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: FILE_PATH,
		handler: async (req, res) => {
			if (rejectRequest(req, res)) return;

			if (req.method === "GET" || req.method === "HEAD") {
				await handleRead(ctx, req, res);
				return;
			}
			if (req.method === "POST") {
				await handleWrite(ctx, req, res);
				return;
			}
			sendMethodNotAllowed(res, "GET, HEAD, POST");
		}
	}), "dsh-editor: GET/POST /dsh-editor/file");
}

/** GET：读取一个 UTF-8 文本文件的全文与其版本令牌。 */
async function handleRead(ctx, req, res) {
	const url = new URL(String(req.url), "http://localhost");
	const raw = url.searchParams.get("path") ?? "";
	if (raw === "") {
		sendJson(res, 400, { code: "bad-request", message: "query `path` is required" });
		return;
	}

	let target;
	try {
		target = await ctx.fs.resolve(raw);
	} catch (error) {
		sendJson(res, 400, { code: "bad-path", message: String(error?.message ?? error) });
		return;
	}

	let info;
	try {
		info = await ctx.fs.stat(target);
	} catch (error) {
		sendJson(res, 500, { code: "stat-failed", message: String(error?.message ?? error) });
		return;
	}
	if (info === void 0) {
		sendJson(res, 404, { code: "not-found", message: `no entry at "${raw}"` });
		return;
	}
	if (info.type !== void 0 && info.type !== "file") {
		sendJson(res, 400, { code: "not-regular-file", message: `"${raw}" is a ${info.type}` });
		return;
	}
	if (typeof info.bytes === "number" && info.bytes > MAX_FILE_BYTES) {
		sendJson(res, 413, { code: "too-large", message: `"${raw}" is ${info.bytes} bytes; the sidebar editor caps files at ${MAX_FILE_BYTES}` });
		return;
	}

	let text;
	try {
		text = await ctx.fs.readText(target);
	} catch (error) {
		const code = String(error?.code ?? "");
		sendJson(res, code === "FS_NOT_TEXT" ? 415 : 500, {
			code: code === "FS_NOT_TEXT" ? "not-text" : "read-failed",
			message: String(error?.message ?? error)
		});
		return;
	}

	sendJson(res, 200, { path: raw, version: String(info.version), text });
}

/** POST：把编辑后的全文原子写回磁盘，带可选的版本守卫。 */
async function handleWrite(ctx, req, res) {
	if (String(req.headers["content-type"]).split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
		sendJson(res, 415, { code: "unsupported-media-type", message: "content-type must be application/json" });
		return;
	}

	let raw;
	try {
		raw = await readBoundedBody(req, MAX_BODY_BYTES);
	} catch (error) {
		sendJson(res, error?.code === "too-large" ? 413 : 400, {
			code: error?.code === "too-large" ? "too-large" : "bad-request",
			message: String(error?.message ?? error)
		});
		return;
	}

	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		sendJson(res, 400, { code: "bad-request", message: "body is not valid JSON" });
		return;
	}
	if (typeof body !== "object" || body === null || typeof body.path !== "string" || body.path === "" || typeof body.text !== "string") {
		sendJson(res, 400, { code: "bad-request", message: "body must be an object with string `path` and string `text`" });
		return;
	}
	const expected = typeof body.version === "string" && body.version !== "" ? { version: body.version } : void 0;

	let target;
	try {
		target = await ctx.fs.resolve(body.path);
	} catch (error) {
		sendJson(res, 400, { code: "bad-path", message: String(error?.message ?? error) });
		return;
	}

	try {
		const outcome = await ctx.fs.writeText(target, body.text, expected);
		sendJson(res, 200, { path: body.path, version: String(outcome?.version ?? "") });
	} catch (error) {
		const code = String(error?.code ?? "");
		if (code === "FS_STALE_VERSION") {
			sendJson(res, 409, { code: "stale", message: "the file changed on disk since it was read" });
			return;
		}
		sendJson(res, 500, { code: "write-failed", message: String(error?.message ?? error) });
	}
}
