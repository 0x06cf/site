/**
 * UploadRedirect — Kettu/Vendetta mobile plugin
 * Ported from the Vencord plugin by misticc.
 *
 * Reuploads files through a Nitro-boosted (level 3) channel so you get
 * the 100 MB upload limit everywhere.
 *
 * Settings (stored via vendetta storage):
 *   boostChan  — channel ID of your level-3 server channel
 *   sizeLimitMb — minimum file size (MB) to redirect; 0 = always redirect
 */

// ─── Vendetta / Kettu API ────────────────────────────────────────────────────
const {
    metro: { findByProps },
    storage,
    ui: { toasts },
} = window.vendetta;

// Discord internals
const AuthModule      = findByProps("getToken");
const UploadModule    = findByProps("promptToUpload");

// ─── Persistent settings ─────────────────────────────────────────────────────
// `storage` is a simple key/value store that persists across restarts.
// We namespace everything under "UploadRedirect".
const KEY_CHAN  = "UploadRedirect_boostChan";
const KEY_LIMIT = "UploadRedirect_sizeLimitMb";

function getSetting(key, fallback) {
    const v = storage.get(key);
    return v !== undefined && v !== null ? v : fallback;
}

function setSetting(key, value) {
    storage.set(key, value);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function bigEnough(files) {
    const mb = getSetting(KEY_LIMIT, 0);
    if (mb === 0) return true;
    return files.some(f => f.size > mb * 1024 * 1024);
}

/** Best-effort channel ID from the current route pathname */
function currentChanId() {
    try {
        return window.location.pathname.match(/\/channels\/(?:\d+|@me)\/(\d+)/)?.[1] ?? null;
    } catch {
        return null;
    }
}

function toast(msg, type) {
    // type: "success" | "failure" | "message"
    toasts.open({ content: msg, source: type === "failure" ? "danger" : type });
}

// ─── Core reupload logic ──────────────────────────────────────────────────────
async function reupload(files, originalChan) {
    const destChan = (getSetting(KEY_CHAN, "") ?? "").trim();
    if (!destChan) {
        toast("UploadRedirect: set a channel ID first in settings", "failure");
        return;
    }

    toast("UploadRedirect: uploading…", "message");

    const fd = new FormData();
    files.forEach((f, i) => fd.append(`files[${i}]`, f, f.name));
    fd.append("payload_json", JSON.stringify({
        content: "",
        attachments: files.map((f, i) => ({ id: `${i}`, filename: f.name })),
    }));

    let resp;
    try {
        resp = await fetch(`/api/v9/channels/${destChan}/messages`, {
            method: "POST",
            headers: { Authorization: AuthModule.getToken() },
            body: fd,
        });
    } catch (e) {
        toast("UploadRedirect: network error — " + e.message, "failure");
        return;
    }

    if (!resp.ok) {
        const body = await resp.json().catch(() => ({ message: resp.statusText }));
        toast(`UploadRedirect: failed ${resp.status}: ${body.message}`, "failure");
        return;
    }

    const json = await resp.json();
    if (!json.attachments?.length) {
        toast("UploadRedirect: no attachments returned", "failure");
        return;
    }

    // Re-download from CDN so Discord shows the normal attachment preview
    const redownloaded = await Promise.all(
        json.attachments.map(async (a, i) => {
            const blob = await fetch(a.url).then(r => r.blob());
            return new File([blob], files[i]?.name ?? "file", { type: blob.type });
        })
    );

    UploadModule.promptToUpload(redownloaded, { id: originalChan }, 0);
    toast("UploadRedirect: done!", "success");
}

// ─── Event listener bookkeeping ───────────────────────────────────────────────
const _attached = [];
const _doneInputs = new WeakSet();
let _mo = null;

function _on(el, ev, fn) {
    el.addEventListener(ev, fn, true);
    _attached.push([el, ev, fn]);
}

function hookInput(el) {
    if (_doneInputs.has(el)) return;
    _doneInputs.add(el);
    _on(el, "change", (e) => {
        const inp = e.target;
        const picked = Array.from(inp.files ?? []);
        if (!picked.length || !bigEnough(picked)) return;
        e.stopImmediatePropagation();
        try {
            inp.value = "";
            Object.defineProperty(inp, "files", {
                get: () => new DataTransfer().files,
                configurable: true,
            });
        } catch { /* ignore */ }
        const ch = currentChanId();
        if (ch) reupload(picked, ch);
    });
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────
export default {
    manifest: {
        name: "UploadRedirect",
        description: "Reuploads big files through a boosted server so you get 100 MB limit anywhere",
        authors: [{ name: "misticc", id: "0" }],
    },

    /**
     * Called from the Settings UI (or directly from a future settings sheet).
     * Kettu/Vendetta doesn't have Vencord's typed settings system, so we
     * expose get/set helpers that the settings page can call.
     */
    settings: {
        getBoostChan: ()    => getSetting(KEY_CHAN, ""),
        setBoostChan: (v)   => setSetting(KEY_CHAN, v),
        getSizeLimitMb: ()  => getSetting(KEY_LIMIT, 0),
        setSizeLimitMb: (v) => setSetting(KEY_LIMIT, Number(v)),
    },

    onLoad() {
        const root = document.getElementById("app-mount") ?? document.body;

        // Drag-and-drop
        _on(root, "drop", (e) => {
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (!files.length || !bigEnough(files)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const ch = currentChanId();
            if (ch) reupload(files, ch);
        });

        // Paste
        _on(root, "paste", (e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length || !bigEnough(files)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const ch = currentChanId();
            if (ch) reupload(files, ch);
        });

        // File-picker inputs already in the DOM
        document
            .querySelectorAll('input[type="file"]')
            .forEach(el => hookInput(el));

        // Watch for new file inputs added dynamically
        _mo = new MutationObserver(muts => {
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n instanceof HTMLInputElement && n.type === "file") {
                        hookInput(n);
                    } else if (n instanceof HTMLElement) {
                        n.querySelectorAll('input[type="file"]').forEach(el => hookInput(el));
                    }
                }
            }
        });
        _mo.observe(document.body, { childList: true, subtree: true });
    },

    onUnload() {
        _attached.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn, true));
        _attached.length = 0;
        _mo?.disconnect();
        _mo = null;
    },
};
