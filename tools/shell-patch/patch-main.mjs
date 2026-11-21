// 给 asar 里的 lib/main.js 打「未读数字」补丁（v7）。
// 用法：node patch-main.mjs <输入 main.js> <输出 main.js> <图标目录(含 b13_N / b26_N)>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [input, output, iconDir] = process.argv.slice(2)
const source = readFileSync(input, 'utf8')

const read = name => readFileSync(join(iconDir, name)).toString('base64')
const keys = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
const table = size => `{ ${keys.map(key => `"${key}": "${read(`b${size}_${key}.png`)}"`).join(',\n\t')} }`

const patch = `// ── dsh-notify 未读数字（本机补丁 2026-11-21 v12）──────────────────────────
// 数记在 $DSH_HOME/dsh-notify/badge.json（宿主插件 dsh-notify 写），这里只读不写。
// 只画任务栏图标右下角那一小块，不动托盘图标。
// 图按 13×13 画（Windows 100% 缩放下那块徽标的实际尺寸），5×7 点阵数字居中。
// 圆的几何中心必须压在字形中心上（都取 6.0），不然数字看着偏半格 —— v11 之前圆心在 6.5。
// 1–9，超过 9 停在 9。清除用 null，不是 undefined（undefined 有时留残影）。
// 数字涨了、并且 ui-config.json 的 badge.banner 没关：用 Electron 自己的系统通知弹一条。
// 清零：①窗口在眼前露脸 3 秒就清；②点任务栏图标把窗口叫回来（focus）立刻清。
// 清法是在页面里发同源请求（页面是 dsh-app:// 自定义协议，主进程按 http 判断永远不匹配）。
// DSH 升级会盖掉这段；回滚 = 用 resources/app.asar.bak-20261120-badge 覆盖回去。
const NOTIFY_DIGIT_13 = ${table(13)};
const NOTIFY_DIGIT_26 = ${table(26)};
const notifyBadgeDir = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-notify");
const notifyBadgePath = () => join(notifyBadgeDir(), "badge.json");
const notifyBadgeBanner = () => {
	try {
		const raw = JSON.parse(readFileSync(join(notifyBadgeDir(), "ui-config.json"), "utf8"));
		return raw?.badge?.banner !== false;
	} catch {
		return true;
	}
};
function notifyBadgeImage(count) {
	const key = String(Math.min(count, 9));
	const image = nativeImage.createFromBuffer(Buffer.from(NOTIFY_DIGIT_13[key], "base64"));
	image.addRepresentation({
		scaleFactor: 2,
		buffer: Buffer.from(NOTIFY_DIGIT_26[key], "base64")
	});
	return image;
}
function notifyBadgeToast(window, count, reason) {
	if (!Notification.isSupported()) return;
	const label = reason === "error" ? "任务出错" : reason === "blocked" ? "任务被阻塞" : reason === "max-tokens" ? "超出 token 上限" : "任务完成";
	try {
		const toast = new Notification({
			title: "任务通知",
			body: label + "｜" + count + " 轮跑完了还没看",
			silent: false
		});
		toast.on("click", () => {
			if (window.isDestroyed()) return;
			window.show();
			window.focus();
		});
		toast.show();
	} catch (error) {
		console.warn("notify badge: toast failed", error);
	}
}
function notifyBadgeLog(text) {
	try {
		appendFileSync(join(notifyBadgeDir(), "shell-badge.log"), new Date().toISOString() + " " + text + "\\n");
	} catch {}
}
function notifyBadgeClearFromMain(window) {
	try {
		const url = new URL(window.webContents.getURL());
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			notifyBadgeLog("clear-main-skip protocol=" + url.protocol);
			return Promise.resolve();
		}
		return fetch(url.origin + "/api/dsh-notify/badge/clear", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}"
		}).then(() => notifyBadgeLog("clear-main ok"), (error) => notifyBadgeLog("clear-main-error " + String(error)));
	} catch (error) {
		notifyBadgeLog("clear-main-throw " + String(error));
		return Promise.resolve();
	}
}
function notifyBadgeClear(window) {
	try {
		if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();
		// 首选：页面里发同源请求，不看 webContents 的 URL 是 http 还是自定义协议
		return window.webContents.executeJavaScript(
			"fetch('/api/dsh-notify/badge/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.ok, () => false)",
			true
		).then((ok) => {
			notifyBadgeLog("clear-page ok=" + String(ok));
			if (ok === true) return;
			return notifyBadgeClearFromMain(window);
		}, (error) => {
			notifyBadgeLog("clear-page-error " + String(error));
			return notifyBadgeClearFromMain(window);
		});
	} catch (error) {
		notifyBadgeLog("clear-throw " + String(error));
		return Promise.resolve();
	}
}
function attachNotifyBadge(window) {
	if (window === void 0 || window.isDestroyed()) return;
	let painted = -1;
	let lastAt = 0;
	let lastReason = "";
	let shownAt = 0;
	const paint = (count) => {
		if (window.isDestroyed()) return;
		if (process.platform === "darwin") {
			try {
				app.dock?.setBadge(count > 0 ? String(count) : "");
			} catch {}
			return;
		}
		if (process.platform !== "win32") return;
		try {
			window.setOverlayIcon(count > 0 ? notifyBadgeImage(count) : null, count > 0 ? String(count) + " 轮任务跑完了没看" : "");
		} catch {}
	};
	// 请宿主清零。清不掉（宿主没起来 / 请求没落地）就把计时还回去，下一秒再试。
	const clearNow = () => {
		if (painted <= 0 || shownAt === 0) return;
		notifyBadgeLog("clear-now count=" + String(painted) + " why=" + (window.isFocused() ? "focus" : "timer"));
		shownAt = 0;
		try {
			void notifyBadgeClear(window).catch(() => {
				if (painted > 0 && shownAt === 0) shownAt = Date.now();
			});
		} catch {}
	};
	const tick = () => {
		if (window.isDestroyed()) return;
		// 兜底：窗口在眼前露脸 3 秒就清。点图标进来走下面的 focus，那边是立刻清。
		if (painted > 0 && shownAt > 0 && Date.now() - shownAt > 3e3 && window.isFocused() && !window.isMinimized()) clearNow();
		let count = 0;
		let at = 0;
		let reason = "";
		try {
			const raw = JSON.parse(readFileSync(notifyBadgePath(), "utf8"));
			count = Number.isFinite(raw?.count) ? Math.max(0, Math.floor(raw.count)) : 0;
			at = Number.isFinite(raw?.at) ? raw.at : 0;
			reason = typeof raw?.lastReason === "string" ? raw.lastReason : "";
		} catch {
			count = 0;
		}
		if (count === painted && at === lastAt && reason === lastReason) return;
		const grew = count > painted && painted >= 0;
		painted = count;
		lastAt = at;
		lastReason = reason;
		if (count > 0 && (grew || shownAt === 0)) shownAt = Date.now();
		paint(count);
		notifyBadgeLog(
			"paint count=" + String(count) +
			" focus=" + String(window.isFocused()) +
			" visible=" + String(window.isVisible()) +
			" min=" + String(window.isMinimized()) +
			" url=" + String(window.webContents.getURL()) +
			" at=" + String(at)
		);
		if (grew && notifyBadgeBanner()) notifyBadgeToast(window, count, reason);
	};
	tick();
	const timer = setInterval(tick, 1e3);
	// 点任务栏图标把窗口叫回来：不再等那 3 秒，立刻清。（留 400ms 门槛，免得数字刚冒头就被自己清掉）
	window.on("focus", () => {
		if (painted > 0 && shownAt > 0 && Date.now() - shownAt > 400) clearNow();
	});
	window.once("closed", () => clearInterval(timer));
	notifyBadgeLog("attach ok pid=" + String(process.pid));
}
const createMainWindow = () => {`

const anchor = 'const createMainWindow = () => {'
if (!source.includes(anchor)) {
  console.error(`anchor not found: ${anchor}`)
  process.exit(1)
}
if (source.includes('attachNotifyBadge')) {
  console.error('already patched')
  process.exit(1)
}
let next = source.replace(anchor, patch)

const callAnchor = `\t\tconst window = createWindow(appPreload, false, true);
\t\tmainWindow = window;`
if (!next.includes(callAnchor)) {
  console.error('call anchor not found')
  process.exit(1)
}
next = next.replace(callAnchor, `${callAnchor}
\t\tattachNotifyBadge(window);`)

writeFileSync(output, next, 'utf8')
console.error(`patched ${input} -> ${output} (+${next.length - source.length} bytes)`)
