(function () {
    const { metro, storage, ui } = window.vendetta;
    const { findByProps } = metro;

    const AuthModule = findByProps("getToken");
    const UploadModule = findByProps("promptToUpload");

    const KEY_CHAN  = "UploadRedirect_boostChan";
    const KEY_LIMIT = "UploadRedirect_sizeLimitMb";

    function getSetting(key, fallback) {
        const v = storage.impl.get(key);
        return (v !== undefined && v !== null) ? v : fallback;
    }
    function setSetting(key, value) {
        storage.impl.set(key, value);
    }

    function bigEnough(files) {
        const mb = getSetting(KEY_LIMIT, 0);
        if (mb === 0) return true;
        return files.some(function (f) { return f.size > mb * 1024 * 1024; });
    }

    function currentChanId() {
        try {
            const m = window.location.pathname.match(/\/channels\/(?:\d+|@me)\/(\d+)/);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }

    function toast(msg, type) {
        try {
            ui.toasts.open({ content: msg, source: type === "failure" ? "danger" : type });
        } catch (e) {
            console.log("[UploadRedirect] " + msg);
        }
    }

    async function reupload(files, originalChan) {
        const destChan = (getSetting(KEY_CHAN, "") || "").trim();
        if (!destChan) {
            toast("UploadRedirect: set a boost channel ID in plugin settings first", "failure");
            return;
        }

        toast("UploadRedirect: uploading...", "message");

        const fd = new FormData();
        files.forEach(function (f, i) { fd.append("files[" + i + "]", f, f.name); });
        fd.append("payload_json", JSON.stringify({
            content: "",
            attachments: files.map(function (f, i) { return { id: "" + i, filename: f.name }; })
        }));

        let resp;
        try {
            resp = await fetch("/api/v9/channels/" + destChan + "/messages", {
                method: "POST",
                headers: { Authorization: AuthModule.getToken() },
                body: fd
            });
        } catch (e) {
            toast("UploadRedirect: network error — " + e.message, "failure");
            return;
        }

        if (!resp.ok) {
            const body = await resp.json().catch(function () { return { message: resp.statusText }; });
            toast("UploadRedirect: failed " + resp.status + ": " + body.message, "failure");
            return;
        }

        const json = await resp.json();
        if (!json.attachments || !json.attachments.length) {
            toast("UploadRedirect: no attachments returned", "failure");
            return;
        }

        const redownloaded = await Promise.all(json.attachments.map(async function (a, i) {
            const blob = await fetch(a.url).then(function (r) { return r.blob(); });
            return new File([blob], (files[i] && files[i].name) || "file", { type: blob.type });
        }));

        UploadModule.promptToUpload(redownloaded, { id: originalChan }, 0);
        toast("UploadRedirect: done!", "success");
    }

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
        _on(el, "change", function (e) {
            const inp = e.target;
            const picked = Array.from(inp.files || []);
            if (!picked.length || !bigEnough(picked)) return;
            e.stopImmediatePropagation();
            try {
                inp.value = "";
                Object.defineProperty(inp, "files", {
                    get: function () { return new DataTransfer().files; },
                    configurable: true
                });
            } catch (e) {}
            const ch = currentChanId();
            if (ch) reupload(picked, ch);
        });
    }

    return {
        onLoad: function () {
            const root = document.getElementById("app-mount") || document.body;

            _on(root, "drop", function (e) {
                const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
                if (!files.length || !bigEnough(files)) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const ch = currentChanId();
                if (ch) reupload(files, ch);
            });

            _on(root, "paste", function (e) {
                const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
                if (!files.length || !bigEnough(files)) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const ch = currentChanId();
                if (ch) reupload(files, ch);
            });

            document.querySelectorAll('input[type="file"]').forEach(function (el) { hookInput(el); });

            _mo = new MutationObserver(function (muts) {
                muts.forEach(function (m) {
                    m.addedNodes.forEach(function (n) {
                        if (n instanceof HTMLInputElement && n.type === "file") {
                            hookInput(n);
                        } else if (n instanceof HTMLElement) {
                            n.querySelectorAll('input[type="file"]').forEach(function (el) { hookInput(el); });
                        }
                    });
                });
            });
            _mo.observe(document.body, { childList: true, subtree: true });
        },

        onUnload: function () {
            _attached.forEach(function (entry) {
                entry[0].removeEventListener(entry[1], entry[2], true);
            });
            _attached.length = 0;
            if (_mo) { _mo.disconnect(); _mo = null; }
        }
    };
})();
