// dsh-ask-notify — offline self-check for the client half.
//
//   node _verify/diag/selfcheck-client.js
//
// Loads lib/client.js into a fake DOM + fake harness and asserts what the real
// complaint was about: after installing from the market the plugin must WORK on
// whatever DSH build the user happens to run. Eight scenarios:
//
//   S1  harness 0.1.7+   uiSession.sessionStatus       -> used "uiSession.status"
//   S2  harness 0.1.2-6  uiSession.pendingInteractions -> used "uiSession.pending"
//   S3  harness <=0.1.1  sessions.list row string      -> used "list"
//   S4  UNKNOWN future shape (uiSession.waitQueue)     -> discovered + card drawn
//   S5  nothing readable at all                        -> warns ONCE + notice card
//   S6  decoy maps (titles / status strings)           -> NOT mistaken for waits
//   S7  no cordis inject gate: a ctx with no sessions  -> still mounts the API
//   S8  service appears late                           -> starts without a reload
//
// No browser, no network, no dependencies: plain node.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "client.js"), "utf8");
const SID = "session-abc";
const SID2 = "session-def";

/* ---------------------------------------------------------------- fake DOM */
let registry = {};

function makeEl(tag) {
    var el = {
        tagName: tag,
        id: "",
        parentNode: null,
        children: [],
        attrs: {},
        textContent: "",
        innerHTML: "",
        disabled: false,
        title: "",
        _queries: {},
        _listeners: {},
        style: { setProperty: function (k, v) { this[k] = v; }, bottom: "", cssText: "" },
        classList: {
            _s: {},
            add: function (c) { this._s[c] = true; },
            remove: function (c) { delete this._s[c]; },
            toggle: function (c, on) {
                if (on === undefined) on = this._s[c] !== true;
                if (on) this._s[c] = true; else delete this._s[c];
            },
            contains: function (c) { return this._s[c] === true; }
        },
        setAttribute: function (k, v) { this.attrs[k] = v; },
        getAttribute: function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
        appendChild: function (child) {
            this.children.push(child);
            child.parentNode = this;
            if (child.id) registry[child.id] = child;
            return child;
        },
        removeChild: function (child) {
            this.children = this.children.filter(function (c) { return c !== child; });
            if (registry[child.id] === child) delete registry[child.id];
        },
        remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
        addEventListener: function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        removeEventListener: function () {},
        querySelector: function (sel) {
            if (this._queries[sel] === undefined) this._queries[sel] = makeEl("div");
            return this._queries[sel];
        },
        getBoundingClientRect: function () { return { width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }; },
        scrollIntoView: function () {},
        focus: function () {},
        contains: function () { return false; }
    };
    return el;
}

function makeSandbox() {
    registry = {};
    const body = makeEl("body");
    const head = makeEl("head");
    const document = {
        readyState: "complete",
        title: "DeepSeek Harness",
        hidden: false,
        body: body,
        head: head,
        documentElement: makeEl("html"),
        createElement: makeEl,
        getElementById: function (id) { return registry[id] || null; },
        querySelector: function () { return null; },
        addEventListener: function () {},
        removeEventListener: function () {},
        hasFocus: function () { return true; }
    };
    const store = {};
    const window = {
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        addEventListener: function () {},
        removeEventListener: function () {},
        focus: function () {},
        document: document,
        localStorage: {
            getItem: function (k) { return store[k] === undefined ? null : store[k]; },
            setItem: function (k, v) { store[k] = String(v); },
            removeItem: function (k) { delete store[k]; }
        }
    };
    return { window: window, document: document };
}

/** Load a FRESH copy of the module (module state must not leak between cases). */
function load() {
    const { window, document } = makeSandbox();
    const warns = [];
    const errors = [];
    const sandbox = {
        window: window,
        document: document,
        console: {
            warn: function (msg) { warns.push(String(msg)); },
            log: function () {},
            error: function (a, b) { errors.push(String(a) + (b === undefined ? "" : " || " + String(b && b.message ? b.message : b))); }
        },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval
    };
    let captured = null;
    window.__ModuleLoader__ = { load: function (cfg) { captured = cfg; } };
    vm.runInContext(SOURCE, vm.createContext(sandbox), { filename: "client.js" });
    if (captured === null) throw new Error("module did not register itself with __ModuleLoader__");
    return { mod: captured.factory(), window: window, document: document, warns: warns, errors: errors };
}

/* --------------------------------------------------------- fake harness bits */
function observable(map) {
    return { getSnapshot: function () { return map; }, subscribe: function () { return function () {}; } };
}

function map(entries) {
    const m = new Map();
    entries.forEach(function (e) { m.set(e[0], e[1]); });
    return m;
}

function sessionsOf(rows, current) {
    const byId = {}, ids = [];
    rows.forEach(function (r) { byId[r.id] = r; ids.push(r.id); });
    const snap = { ids: ids, byId: byId, current: current || SID };
    return { list: observable(snap), binding: function () { return null; }, open: function () {} };
}

function ctxOf(services) {
    return { get: function (name) { return services[name]; } };
}

function card(document) {
    return document.getElementById("dsh-ask-notify-card");
}

function cardText(document) {
    const el = card(document);
    if (!el) return "";
    const body = el._queries[".an-body"];
    const label = el._queries[".an-session"];
    return String((label ? label.textContent : "") + " | " + (body ? body.textContent : ""));
}

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : "   -> " + detail));
    if (!ok) failures++;
}

/* --------------------------------------------------------------- scenarios */
function s1() {
    console.log("S1  harness 0.1.7+ : uiSession.sessionStatus");
    const app = load();
    app.mod.apply(ctxOf({
        sessions: sessionsOf([{ id: SID, displayTitle: "会话一" }]),
        uiSession: {
            sessionStatus: observable(map([[SID, { status: "waiting", pendingInteraction: { kind: "approval", payload: { question: "要不要继续删库？" } } }]]))
        }
    }));
    const api = app.window.__dshAskNotify;
    const src = api.sources();
    check("used = uiSession.status", src.used === "uiSession.status", src.used);
    check("pending = 1", api.collect().length === 1, JSON.stringify(api.collect()));
    check("kind = approval", api.collect()[0].kind === "approval", JSON.stringify(api.collect()[0]));
    check("card carries the question text", cardText(app.document).indexOf("要不要继续删库") >= 0, cardText(app.document));
}

function s2() {
    console.log("S2  harness 0.1.2 .. 0.1.6 : uiSession.pendingInteractions");
    const app = load();
    app.mod.apply(ctxOf({
        sessions: sessionsOf([{ id: SID, displayTitle: "会话一" }]),
        uiSession: { pendingInteractions: observable(map([[SID, { key: "k1", kind: "question", sessionId: SID }]])) }
    }));
    const api = app.window.__dshAskNotify;
    const src = api.sources();
    check("used = uiSession.pending", src.used === "uiSession.pending", src.used);
    check("kind = question", api.collect()[0] && api.collect()[0].kind === "question", JSON.stringify(api.collect()));
    check("no payload -> empty text, card still drawn", card(app.document) !== null, "no card");
}

function s3() {
    console.log("S3  harness <= 0.1.1-rc.x : sessions.list row (status string)");
    const app = load();
    app.mod.apply(ctxOf({ sessions: sessionsOf([{ id: SID, displayTitle: "会话一", pendingInteraction: "question" }]) }));
    const api = app.window.__dshAskNotify;
    check("used = list", api.sources().used === "list", api.sources().used);
    check("kind = question", api.collect()[0] && api.collect()[0].kind === "question", JSON.stringify(api.collect()));
}

function s4() {
    console.log("S4  UNKNOWN future shape : uiSession.waitQueue (auto-discovery)");
    const app = load();
    app.mod.apply(ctxOf({
        sessions: sessionsOf([{ id: SID, displayTitle: "会话一" }]),
        uiSession: { waitQueue: observable(map([[SID, { kind: "approval", key: "q9", sessionId: SID, payload: { question: "未来的形状" } }]])) }
    }));
    const api = app.window.__dshAskNotify;
    const src = api.sources();
    check("used = the discovered source", src.used === "uiSession.waitQueue", src.used);
    check("discovered lists it", src.discovered.indexOf("uiSession.waitQueue") >= 0, JSON.stringify(src.discovered));
    check("kind = approval", api.collect()[0] && api.collect()[0].kind === "approval", JSON.stringify(api.collect()));
    check("text = 未来的形状", api.collect()[0] && api.collect()[0].text === "未来的形状", JSON.stringify(api.collect()[0]));
    check("card data-kind = approval", card(app.document) && card(app.document).attrs["data-kind"] === "approval", cardText(app.document));
    check("no warning", app.warns.length === 0, JSON.stringify(app.warns));
}

function s5() {
    console.log("S5  nothing readable at all : must warn once, out loud");
    const app = load();
    app.mod.apply(ctxOf({}));
    const api = app.window.__dshAskNotify;
    check("used = none", api.sources().used === "none", api.sources().used);
    check("pending = 0", api.sources().pending === 0, String(api.sources().pending));
    api.reconcile();
    api.reconcile();
    api.reconcile();
    check("warned exactly once", app.warns.length === 1, String(app.warns.length));
    check("warning is the actionable one", app.warns.length > 0 && app.warns[0].indexOf("读不到等待态数据源") >= 0, String(app.warns[0]));
    check("notice card drawn", card(app.document) !== null, "no card; errors=" + JSON.stringify(app.errors) + " noticeError=" + JSON.stringify(app.window.__dshAskNotify.state().noticeError));
    check("notice tells the user what to run", cardText(app.document).indexOf("F12") >= 0, cardText(app.document));
}

function s6() {
    console.log("S6  decoy maps : must NOT be mistaken for waits");
    const app = load();
    app.mod.apply(ctxOf({
        sessions: sessionsOf([{ id: SID, displayTitle: "会话一" }], SID),
        uiSession: {
            titles: observable(map([[SID, "会话一"]])) ,                       // string map, live id
            states: observable(map([[SID, { status: "busy" }]])),              // object, no `kind`
            drafts: observable(map([[SID, { kind: "Draft.Title" }]]))          // bad kind shape
        }
    }));
    const api = app.window.__dshAskNotify;
    const src = api.sources();
    check("still used = list", src.used === "list", src.used);
    check("discovered nothing", src.discovered.length === 0, JSON.stringify(src.discovered));
    check("pending = 0", api.collect().length === 0, JSON.stringify(api.collect()));
    check("no card drawn", card(app.document) === null, cardText(app.document));
}

function s7() {
    console.log("S7  no cordis inject gate : a ctx without `sessions` still mounts the API");
    const app = load();
    app.mod.apply(ctxOf({ uiSession: { pendingInteractions: observable(map([[SID, { kind: "question", key: "k2", sessionId: SID }]])) } }));
    const api = app.window.__dshAskNotify;
    check("API exposed", api && api.version === "1.0.4", api && api.version);
    check("no sessions, but still reads", api.sources().used === "uiSession.pending", api.sources().used);
    check("pending = 1", api.collect().length === 1, JSON.stringify(api.collect()));
}

async function s8() {
    console.log("S8  service appears late : starts without a reload");
    const app = load();
    let ready = false;
    app.mod.apply({ get: function (name) { return ready ? services[name] : undefined; } });
    const services = { sessions: sessionsOf([{ id: SID, displayTitle: "会话一", pendingInteraction: "question" }]) };
    const api = app.window.__dshAskNotify;
    check("nothing yet", api.sources().used === "none", api.sources().used);
    ready = true;                       // the runtime finishes booting 500ms later
    await new Promise(function (r) { setTimeout(r, 900); });
    check("readable after boot", api.sources().used === "list", api.sources().used);
    check("card drawn after boot", card(app.document) !== null, "no card");
}

(async function () {
    console.log("dsh-ask-notify client self-check — source " + SOURCE.length + " bytes\n");
    s1(); s2(); s3(); s4(); s5(); s6(); s7();
    await s8();
    console.log("\n" + (failures === 0 ? "ALL SCENARIOS PASS" : failures + " CHECK(S) FAILED"));
    process.exit(failures === 0 ? 0 : 1);
})();
