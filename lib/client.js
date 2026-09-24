// dsh-ask-notify — client half.
//
// Author : liujianqiao701 (https://github.com/liujianqiao701)
// License: MIT
//
// A bottom-right reminder for the one situation the GUI cannot cover on its
// own: the agent is blocked waiting for a human answer, and the human is
// looking at another tab / another application.
//
// Three escalating channels, all driven by one pending-interaction fact, read
// from whichever source the running harness exposes -- the shape moved TWICE
// between harness generations, so every known source is probed in order and
// anything unrecognised is DISCOVERED at runtime (see pendingSources below):
//
//   1. uiSession.sessionStatus                                   (harness 0.1.7+)
//        getSnapshot().get(id).pendingInteraction -> { kind, payload, ... }
//   2. uiSession.pendingInteractions                        (0.1.2 .. 0.1.6)
//        getSnapshot().get(id)                    -> { key, kind, sessionId, ... }
//   3. the sessions.list snapshot row                      (<= 0.1.1-rc.x)
//        byId[id].pendingInteraction              -> status STRING
//   4. any other map-like member of `uiSession` / `sessions` that is actually
//      holding waits right now -- found by scanning, so a future rename is
//      picked up by the plugin users already have instead of needing a release.
//
// The list row lost the field in 0.1.2; from then on the ui-session service
// publishes the state "independent from Controller snapshots". The card text is
// enriched from the session face's ConversationSnapshot.pending payload when
// that is available.
//
// Nothing here is a cordis `inject` dependency, and nothing fails silently: if
// NO source at all can be read (a harness shape nobody has seen yet), the
// plugin says so in the console AND draws a one-shot notice card, rather than
// sitting there looking installed.
//
//   1. an in-page card pinned to the bottom-right corner (always, while pending)
//   2. a desktop notification  (only while the page is hidden or unfocused)
//   3. a blinking document title prefix (only while the page is hidden)
//
// Loaded through window.__ModuleLoader__ exactly like the built-in client plugins.
window.__ModuleLoader__.load({
	id: "dsh-ask-notify",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;

		var VERSION = "1.0.4";
		var CARD_ID = "dsh-ask-notify-card";
		var STYLE_ID = "dsh-ask-notify-style";
		var PREFS_KEY = "dsh-ask-notify:prefs";
		var SHOT_KEY = "dsh-ask-notify:lastshot";
		var AUTOASK_KEY = "dsh-ask-notify:autoasked";
		var TITLE_PREFIX = "❓ ";
		var POLL_MS = 2000;
		var SHOT_DEDUPE_MS = 20000;

		var TAB_ID = "tab-" + Math.random().toString(36).slice(2, 10);

		/** Alert preferences: which waits speak up, and through which channels. */
		var DEFAULT_PREFS = {
			question: true,
			approval: true,
			"plan-review": true,
			system: true,
			sound: true
		};

		var KIND_META = {
			question: { icon: "❓", title: "需要你回答问题", accent: "#ffb020" },
			approval: { icon: "🔐", title: "需要你确认操作", accent: "#4c9aff" },
			"plan-review": { icon: "📋", title: "计划等待你确认", accent: "#a56bff" }
		};

		var state = {
			ctx: null,
			pending: null,
			prefs: null,
			dismissedKey: null,
			lastSystemKey: null,
			blinkTimer: null,
			blinkOn: false,
			pollTimer: null,
			subscriptions: [],
			domHandler: null,
			/** While a manual self-test is on screen, the live state must not wipe it. */
			selftestUntil: 0
		};

		/* ------------------------------------------------------------------ */
		/* preferences                                                         */
		/* ------------------------------------------------------------------ */

		function loadPrefs() {
			var prefs = {};
			var key;
			for (key in DEFAULT_PREFS) prefs[key] = DEFAULT_PREFS[key];
			try {
				var raw = window.localStorage.getItem(PREFS_KEY);
				var saved = raw ? JSON.parse(raw) : null;
				if (saved && typeof saved === "object") {
					for (key in DEFAULT_PREFS) {
						if (typeof saved[key] === "boolean") prefs[key] = saved[key];
					}
				}
			} catch (e) {}
			return prefs;
		}

		function savePrefs() {
			try {
				window.localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
			} catch (e) {}
		}

		/* ------------------------------------------------------------------ */
		/* reading pending interactions                                        */
		/* ------------------------------------------------------------------ */

		/** First meaningful string inside one interaction payload (shape-tolerant). */
		function payloadText(payload) {
			if (!payload || typeof payload !== "object") return "";
			try {
				if (Array.isArray(payload.questions) && payload.questions.length > 0) {
					var q = payload.questions[0] || {};
					var head = typeof q.header === "string" ? q.header : "";
					var body = typeof q.question === "string" ? q.question : "";
					var joined = [head, body].filter(function (s) {
						return s !== "";
					}).join(" · ");
					if (joined !== "") return joined;
				}
				var flatKeys = ["question", "detail", "title", "text", "description", "summary", "prompt", "plan", "command"];
				for (var i = 0; i < flatKeys.length; i++) {
					var v = payload[flatKeys[i]];
					if (typeof v === "string" && v.trim() !== "") return v;
				}
				// last resort: one level of nesting (e.g. { request: { description } })
				for (var k in payload) {
					var nested = payload[k];
					if (!nested || typeof nested !== "object") continue;
					for (var j = 0; j < flatKeys.length; j++) {
						var nv = nested[flatKeys[j]];
						if (typeof nv === "string" && nv.trim() !== "") return nv;
					}
				}
			} catch (e) {}
			return "";
		}

		/** Status name -> alert kind ('plan-review' survives as its own kind). */
		function kindOf(status) {
			if (status === "approval") return "approval";
			if (status === "plan-review") return "plan-review";
			return "question";
		}

		/**
		 * Describe one wait. `raw` is the pending value exactly as the active
		 * source published it -- a status string on older harnesses, an
		 * interaction object on newer ones -- and may already carry the text.
		 */
		function describe(sessionId, status, sessions, row, raw) {
			var out = {
				sessionId: sessionId,
				status: status,
				kind: kindOf(status),
				key: "s:" + sessionId + ":" + status,
				text: "",
				label: (row && (row.displayTitle || row.title)) || String(sessionId).slice(0, 12)
			};
			// Newer harnesses hand us the interaction record itself: take its text.
			try {
				if (raw && typeof raw === "object") {
					if (typeof raw.key === "string" && raw.key !== "") out.key = raw.key;
					if (typeof raw.kind === "string" && raw.kind !== "") out.kind = kindOf(raw.kind);
					var inlineIntent = raw.payload && raw.payload.intent;
					if (inlineIntent && inlineIntent.kind === "plan-review") out.kind = "plan-review";
					out.text = payloadText(raw.payload) || payloadText(raw);
				}
			} catch (e) {}
			// Otherwise fall back to the session face's pending payload.
			if (!out.text) try {
				var binding = sessions.binding(sessionId);
				var face = binding && binding.session;
				var snap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : null;
				var items = snap && snap.pending ? snap.pending : [];
				for (var i = 0; i < items.length; i++) {
					var item = items[i];
					if (!item) continue;
					var wantApproval = status === "approval";
					if ((item.kind === "approval") !== wantApproval) continue;
					var text = payloadText(item.payload);
					var intent = item.payload && item.payload.intent;
					if (item.key) out.key = item.key;
					if (text) out.text = text;
					if (intent && intent.kind === "plan-review") out.kind = "plan-review";
					if (out.text) break;
				}
			} catch (e) {}
			return out;
		}

		/** The sessions service, or null when it is not available (yet). */
		function sessionsService() {
			try {
				return state.ctx && typeof state.ctx.get === "function" ? state.ctx.get("sessions") : null;
			} catch (e) {
				return null;
			}
		}

		/** The session-list snapshot (older source), or null. */
		function listSnapshot(sessions) {
			try {
				var list = sessions && sessions.list;
				return list && typeof list.getSnapshot === "function" ? list.getSnapshot() || null : null;
			} catch (e) {
				return null;
			}
		}

		/** The uiSession service, or null when this harness has no such service. */
		function uiService() {
			try {
				return state.ctx && typeof state.ctx.get === "function" ? state.ctx.get("uiSession") : null;
			} catch (e) {
				return null;
			}
		}

		/** The map behind a host observable, or null when the shape is not one. */
		function observableMap(observable) {
			try {
				if (!observable || typeof observable.getSnapshot !== "function") return null;
				var map = observable.getSnapshot();
				return map && typeof map.get === "function" ? map : null;
			} catch (e) {
				return null;
			}
		}

		/** Every session id a map carries. */
		function mapIds(map) {
			var ids = [];
			try {
				map.forEach(function (value, id) {
					ids.push(id);
				});
			} catch (e) {}
			return ids;
		}

		/**
		 * Every pending source this harness exposes, newest generation first.
		 * Each entry is `{ name, ids, value(id) }`, where `value` returns the raw
		 * pending value or null when that source has nothing for the session.
		 */
		/**
		 * One map-backed source. `pick` says what the wait value is:
		 *   "entry" - the entry itself is the interaction record (0.1.2 .. 0.1.6)
		 *   "inner" - the entry is a status carrying `pendingInteraction` (0.1.7+)
		 *   "auto"  - unknown shape: prefer `pendingInteraction`, else the entry
		 */
		function mapSource(name, map, pick, dynamic) {
			return {
				name: name,
				ids: mapIds(map),
				dynamic: dynamic === true,
				value: function (id) {
					var entry;
					try {
						entry = map.get(id);
					} catch (e) {
						return null;
					}
					if (entry === undefined || entry === null || entry === false) return null;
					if (pick === "entry") return entry;
					var inner;
					try {
						inner = typeof entry === "object" ? entry.pendingInteraction : undefined;
					} catch (e) {
						inner = undefined;
					}
					if (pick === "inner") return inner === undefined || inner === null ? null : inner;
					return inner === undefined || inner === null ? entry : inner;
				}
			};
		}

		/** A Map, or an observable wrapping one. */
		function mapLike(value) {
			var observable = observableMap(value);
			if (observable) return observable;
			try {
				if (value && typeof value.get === "function" && typeof value.forEach === "function") return value;
			} catch (e) {}
			return null;
		}

		/**
		 * Own + inherited member names. Field-style services put their state on the
		 * instance, accessor-style ones on the prototype where Object.keys() would
		 * never see them.
		 */
		function memberNames(obj) {
			var names = [];
			var seen = {};
			var cur = obj;
			for (var depth = 0; cur && depth < 4; depth++) {
				var list;
				try {
					list = Object.getOwnPropertyNames(cur);
				} catch (e) {
					break;
				}
				for (var i = 0; i < list.length; i++) {
					var name = list[i];
					if (name === "constructor" || seen[name] === true) continue;
					seen[name] = true;
					names.push(name);
				}
				cur = Object.getPrototypeOf(cur);
				if (cur === Object.prototype || cur === null) break;
			}
			return names;
		}

		/**
		 * Does one map entry look like a wait? Deliberately tight, because a wrong
		 * guess paints a card that answering does not clear. An UNKNOWN source
		 * must carry a kind-like `kind` of its own -- a bare string is NOT enough
		 * (a title / draft map keyed by session id would match that), which is why
		 * the one string-shaped generation is probed by name instead.
		 */
		function looksPending(entry, id, live) {
			if (entry === undefined || entry === null || entry === false) return false;
			var raw = entry;
			try {
				if (typeof entry === "object" && entry.pendingInteraction !== undefined && entry.pendingInteraction !== null) {
					raw = entry.pendingInteraction;
				}
			} catch (e) {}
			if (typeof raw !== "object") return false;
			var kind = raw.kind;
			if (typeof kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(kind)) return false;
			return typeof raw.sessionId === "string" || typeof raw.key === "string" || live[id] === true;
		}

		/**
		 * Members that are structurally not a pending map. Cheap, and it keeps the
		 * scan away from the session list / event plumbing it would otherwise
		 * re-read on every poll.
		 */
		var NOT_PENDING = {
			list: true, binding: true, snapshot: true, subscribe: true, dispose: true,
			open: true, current: true, byId: true, ids: true, events: true, stream: true,
			create: true, close: true, get: true, set: true, delete: true, has: true,
			keys: true, values: true, entries: true, forEach: true, size: true
		};

		/** The services that may expose waits (priority order). */
		function sourceHosts() {
			var hosts = [];
			try {
				var ui = uiService();
				if (ui) hosts.push({ name: "uiSession", value: ui });
				var sessions = sessionsService();
				if (sessions) hosts.push({ name: "sessions", value: sessions });
			} catch (e) {}
			return hosts;
		}

		/**
		 * Any OTHER member of `uiSession` / `sessions` that currently holds waits.
		 * The three named generations below are what exists today; this is what
		 * keeps a future rename from silently switching the plugin off -- the
		 * failure that otherwise needs a new release from the author to fix.
		 */
		function discoveredSources(live) {
			var out = [];
			var hosts = sourceHosts();
			for (var h = 0; h < hosts.length; h++) {
				var host = hosts[h];
				var names = memberNames(host.value);
				for (var i = 0; i < names.length; i++) {
					var member = names[i];
					if (NOT_PENDING[member] === true) continue;
					var value;
					try {
						value = host.value[member];
					} catch (e) {
						continue;
					}
					var map = mapLike(value);
					if (!map) continue;
					var ids = mapIds(map);
					if (ids.length === 0) continue;
					var hit = false;
					for (var j = 0; j < ids.length && !hit; j++) {
						var entry;
						try {
							entry = map.get(ids[j]);
						} catch (e) {
							entry = undefined;
						}
						if (looksPending(entry, ids[j], live)) hit = true;
					}
					if (!hit) continue;
					out.push(mapSource(host.name + "." + member, map, "auto", true));
				}
			}
			return out;
		}

		function pendingSources() {
			var out = [];
			var seen = {};
			var push = function (source) {
				if (seen[source.name] === true) return;
				seen[source.name] = true;
				out.push(source);
			};
			var ui = uiService();
			// 0.1.7+ : per-session status; the value carries `pendingInteraction`.
			var statusMap = observableMap(ui && ui.sessionStatus);
			if (statusMap) push(mapSource("uiSession.status", statusMap, "inner"));
			// 0.1.2 .. 0.1.6 : the interaction record itself is the value.
			var pendingMap = observableMap(ui && ui.pendingInteractions);
			if (pendingMap) push(mapSource("uiSession.pending", pendingMap, "entry"));
			// <= 0.1.1-rc.x : the session-list row still carried the status string.
			var sessions = sessionsService();
			var snap = listSnapshot(sessions);
			if (snap) push({
				name: "list",
				ids: snap.ids && snap.ids.length ? snap.ids : Object.keys(snap.byId || {}),
				dynamic: false,
				value: function (id) {
					var row = snap.byId ? snap.byId[id] : null;
					return row && row.pendingInteraction !== undefined && row.pendingInteraction !== null ? row.pendingInteraction : null;
				}
			});
			// Anything else this build exposes under a name nobody has seen yet.
			var live = {};
			if (snap && snap.byId) {
				for (var id in snap.byId) live[id] = true;
			}
			var found = discoveredSources(live);
			for (var k = 0; k < found.length; k++) push(found[k]);
			return out;
		}

		/**
		 * Normalize one source's pending value into a status string. Older
		 * harnesses store the status string itself; newer ones store the
		 * interaction object, whose kind lives on itself or on its payload.
		 */
		function pendingStatus(raw) {
			if (raw === null || raw === undefined || raw === false) return "";
			if (typeof raw === "string") return raw;
			if (typeof raw !== "object") return "";
			var direct = [raw.kind, raw.status, raw.type];
			for (var i = 0; i < direct.length; i++) {
				if (typeof direct[i] === "string" && direct[i] !== "") return direct[i];
			}
			try {
				var payload = raw.payload && typeof raw.payload === "object" ? raw.payload : null;
				if (payload) {
					if (typeof payload.kind === "string" && payload.kind !== "") return payload.kind;
					var intent = payload.intent;
					if (intent && typeof intent.kind === "string" && intent.kind !== "") return intent.kind;
				}
				if (raw.interaction) return pendingStatus(raw.interaction) || "question";
			} catch (e) {}
			// An interaction exists but names no status: treat it as a question.
			return "question";
		}

		/**
		 * Current pending waits; the current session wins. Every known source is
		 * probed in priority order, so one build serves every harness generation.
		 */
		function collectPending() {
			var out = [];
			var sessions = sessionsService();
			var snap = listSnapshot(sessions);
			var sourcesList = pendingSources();
			if (sourcesList.length === 0) return out;

			var seen = {};
			var ids = [];
			var push = function (id) {
				if (typeof id !== "string" || id === "" || seen[id]) return;
				seen[id] = true;
				ids.push(id);
			};
			for (var s = 0; s < sourcesList.length; s++) {
				var fromSource = sourcesList[s].ids;
				for (var i = 0; i < fromSource.length; i++) push(fromSource[i]);
			}

			for (var j = 0; j < ids.length; j++) {
				var id = ids[j];
				var raw = null;
				for (var k = 0; k < sourcesList.length && raw === null; k++) raw = sourcesList[k].value(id);
				var status = pendingStatus(raw);
				if (status === "") continue;
				if (state.prefs[status] === false) continue;
				var row = snap && snap.byId ? snap.byId[id] : null;
				out.push(describe(id, status, sessions, row, raw));
			}
			if (out.length > 1 && snap && snap.current) {
				out.sort(function (a, b) {
					return (b.sessionId === snap.current ? 1 : 0) - (a.sessionId === snap.current ? 1 : 0);
				});
			}
			return out;
		}

		/**
		 * The source that is actually YIELDING wait data right now, falling back
		 * to the first one that merely exists. `used` has to name the source that
		 * produced the card: reporting the first source that happens to exist sent
		 * one round of debugging down the wrong path already.
		 */
		function usedSource(all) {
			for (var s = 0; s < all.length; s++) {
				var ids = all[s].ids;
				for (var i = 0; i < ids.length; i++) {
					var raw;
					try {
						raw = all[s].value(ids[i]);
					} catch (e) {
						raw = null;
					}
					if (raw !== null && raw !== undefined && raw !== false) return all[s].name;
				}
			}
			return all.length ? all[0].name : "none";
		}

		/**
		 * Which pending data sources this harness actually exposes -- the first
		 * thing to ask when the plugin looks dead. `carries` reports whether a
		 * source holds anything at all right now, not whether the field exists.
		 */
		function sources() {
			var sessions = sessionsService();
			var snap = listSnapshot(sessions);
			var ui = uiService();
			var statusMap = observableMap(ui && ui.sessionStatus);
			var pendingMap = observableMap(ui && ui.pendingInteractions);
			var listCarries = false;
			if (snap && snap.byId) {
				for (var id in snap.byId) {
					if (snap.byId[id] && snap.byId[id].pendingInteraction !== undefined) {
						listCarries = true;
						break;
					}
				}
			}
			var all = pendingSources();
			var discovered = [];
			for (var i = 0; i < all.length; i++) {
				if (all[i].dynamic === true) discovered.push(all[i].name);
			}
			return {
				version: VERSION,
				sessions: Boolean(sessions),
				list: Boolean(snap),
				uiSession: Boolean(ui),
				uiSessionStatus: Boolean(statusMap),
				uiSessionPending: Boolean(pendingMap),
				carries: {
					uiSessionStatus: mapIds(statusMap).length,
					uiSessionPending: mapIds(pendingMap).length,
					list: listCarries
				},
				discovered: discovered,
				used: usedSource(all),
				pending: collectPending().length
			};
		}

		var SOURCE_WARNED = false;

		/** A notice must not outlive the problem it reports. */
		function clearNoticeIfWorking() {
			if (state.noticeShown !== true) return;
			state.noticeShown = false;
			if (state.pending) return;
			try {
				removeCard();
			} catch (e) {}
		}

		/** One-shot notice drawn through the normal card, for a plugin that cannot work. */
		function noticeCard(label, text) {
			if (state.noticeShown === true) return;
			state.noticeShown = true;
			try {
				renderCard({ key: "dsh-ask-notify:no-source", kind: "question", sessionId: "", label: label, text: text });
			} catch (e) {
				// Never swallow this one: if the notice cannot be drawn either, the
				// console is the only channel left.
				state.noticeError = String(e && e.message ? e.message : e);
				try {
					console.error("[dsh-ask-notify] notice card failed", e);
				} catch (e2) {}
			}
		}

		/**
		 * Speak up when no pending source can be read at all. An EMPTY source is
		 * normal (nothing is pending); an ABSENT source means this plugin can
		 * never fire -- and that used to happen with no word to anyone, because a
		 * plugin that reads nothing simply never draws anything.
		 */
		function warnIfNoSource() {
			if (pendingSources().length > 0) {
				clearNoticeIfWorking();
				return;
			}
			if (SOURCE_WARNED) return;
			SOURCE_WARNED = true;
			var report = sources();
			try {
				window.__dshAskNotify.lastSourceReport = report;
			} catch (e) {}
			try {
				console.warn("[dsh-ask-notify] 读不到等待态数据源：uiSession.sessionStatus、uiSession.pendingInteractions、会话列表行，以及自动探测都拿不到等待中数据，右下角提醒不会触发。请在控制台执行 copy(JSON.stringify(__dshAskNotify.sources()))，把结果发给作者。", report);
			} catch (e) {}
			noticeCard("提醒插件读不到数据", "dsh-ask-notify 已加载，但这个 DSH 版本没有它能读的「等待中」数据源（多半是新版换了接口）。请按 F12 → 控制台执行：copy(JSON.stringify(__dshAskNotify.sources()))，把复制到的内容发给作者。");
		}

		/* ------------------------------------------------------------------ */
		/* page-level signals                                                  */
		/* ------------------------------------------------------------------ */

		/** True when the human is demonstrably not looking at this page. */
		function pageIsAway() {
			if (typeof document === "undefined") return false;
			if (document.hidden) return true;
			try {
				return document.hasFocus() === false;
			} catch (e) {
				return false;
			}
		}

		function currentBaseTitle() {
			var t = String(document.title || "");
			while (t.indexOf(TITLE_PREFIX) === 0) t = t.slice(TITLE_PREFIX.length);
			return t;
		}

		function startTitleBlink() {
			if (state.blinkTimer !== null) return;
			state.blinkOn = true;
			document.title = TITLE_PREFIX + currentBaseTitle();
			state.blinkTimer = window.setInterval(function () {
				state.blinkOn = !state.blinkOn;
				document.title = state.blinkOn ? TITLE_PREFIX + currentBaseTitle() : currentBaseTitle();
			}, 1200);
		}

		function stopTitleBlink() {
			if (state.blinkTimer !== null) {
				window.clearInterval(state.blinkTimer);
				state.blinkTimer = null;
			}
			document.title = currentBaseTitle();
			state.blinkOn = false;
		}

		/** Short two-tone chime; silently skipped when audio is unavailable. */
		function chime() {
			try {
				var Ctor = window.AudioContext || window.webkitAudioContext;
				if (!Ctor) return;
				var audio = new Ctor();
				if (audio.state === "suspended" && audio.resume) audio.resume();
				var now = audio.currentTime;
				[880, 1180].forEach(function (freq, index) {
					var osc = audio.createOscillator();
					var gain = audio.createGain();
					osc.type = "sine";
					osc.frequency.value = freq;
					var at = now + index * 0.16;
					gain.gain.setValueAtTime(0.0001, at);
					gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
					gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
					osc.connect(gain);
					gain.connect(audio.destination);
					osc.start(at);
					osc.stop(at + 0.16);
				});
				window.setTimeout(function () {
					try {
						audio.close();
					} catch (e) {}
				}, 700);
			} catch (e) {}
		}

		/* ------------------------------------------------------------------ */
		/* desktop notification                                                */
		/* ------------------------------------------------------------------ */

		function notificationsSupported() {
			return typeof window.Notification === "function" || typeof window.Notification === "object";
		}

		function permission() {
			try {
				return notificationsSupported() ? window.Notification.permission : "unsupported";
			} catch (e) {
				return "unsupported";
			}
		}

		/** Cross-tab dedupe: only one tab raises the desktop toast per wait. */
		function claimToast(key) {
			try {
				var raw = window.localStorage.getItem(SHOT_KEY);
				var prev = raw ? JSON.parse(raw) : null;
				var now = Date.now();
				if (prev && prev.key === key && prev.tab !== TAB_ID && now - (prev.at || 0) < SHOT_DEDUPE_MS) return false;
				window.localStorage.setItem(SHOT_KEY, JSON.stringify({ key: key, tab: TAB_ID, at: now }));
			} catch (e) {}
			return true;
		}

		function fireSystemNotification(item) {
			if (!notificationsSupported()) return;
			if (permission() !== "granted") return;
			if (!claimToast(item.key)) return;
			var meta = KIND_META[item.kind] || KIND_META.question;
			var body = item.text ? item.text.slice(0, 200) : "打开 DSH 页面回答后我才能继续。";
			try {
				var note = new window.Notification(meta.icon + " DSH：" + meta.title, {
					body: body + "\n会话：" + item.label,
					tag: "dsh-ask-notify:" + item.key,
					requireInteraction: true,
					renotify: true
				});
				note.onclick = function () {
					try {
						window.focus();
						note.close();
					} catch (e) {}
				};
				window.setTimeout(function () {
					try {
						note.close();
					} catch (e) {}
				}, 60000);
			} catch (e) {}
		}

		/** Ask for the permission from a user gesture (browser requirement). */
		function requestPermission() {
			if (!notificationsSupported()) {
				setHint("当前浏览器不支持桌面通知。");
				return;
			}
			try {
				var result = window.Notification.requestPermission();
				if (result && typeof result.then === "function") {
					result.then(function (granted) {
						state.prefs.system = granted === "granted";
						savePrefs();
						setHint(granted === "granted" ? "桌面提醒已开启。" : "桌面提醒被浏览器拒绝，请在地址栏左侧的站点设置里允许通知。");
						render();
					});
				} else {
					render();
				}
			} catch (e) {}
		}

		/**
		 * One-shot auto-request: without the permission the desktop toast — the only
		 * channel that reaches a human looking at another tab — stays silent, and
		 * the click that would grant it is exactly what an away human never makes.
		 * So the first gesture anywhere in the GUI is spent on it, once ever.
		 */
		function maybeAutoAsk() {
			if (state.prefs.system !== true) return;
			if (!notificationsSupported() || permission() !== "default") return;
			try {
				if (window.localStorage.getItem(AUTOASK_KEY) === "done") return;
				window.localStorage.setItem(AUTOASK_KEY, "done");
			} catch (e) {}
			requestPermission();
		}

		/* ------------------------------------------------------------------ */
		/* the bottom-right card                                               */
		/* ------------------------------------------------------------------ */
		var CSS = [
			"#dsh-ask-notify-card{position:fixed;right:24px;bottom:18px;z-index:2147483600;width:370px;max-width:92vw;box-sizing:border-box;padding:12px 13px 11px;border-radius:14px;",
			"font:13px/1.5 'Segoe UI',-apple-system,BlinkMacSystemFont,'Microsoft YaHei',sans-serif;color:#f5f7ff;",
			"background:linear-gradient(160deg,rgba(28,34,58,.97),rgba(18,22,38,.98));border:1px solid var(--an-accent);",
			"box-shadow:0 18px 44px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.04) inset;animation:dsh-ask-in .26s ease-out}",
			"@keyframes dsh-ask-in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}",
			"#dsh-ask-notify-card .an-head{display:flex;align-items:center;gap:7px;margin-bottom:6px}",
			"#dsh-ask-notify-card .an-icon{font-size:16px;line-height:1}",
			"#dsh-ask-notify-card .an-title{font-weight:600;font-size:13.5px;color:var(--an-accent)}",
			"#dsh-ask-notify-card .an-session{margin-left:auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:#9aa3bd}",
			"#dsh-ask-notify-card .an-x{border:0;background:transparent;color:#8c93aa;font-size:16px;line-height:1;cursor:pointer;padding:0 2px}",
			"#dsh-ask-notify-card .an-x:hover{color:#fff}",
			"#dsh-ask-notify-card .an-body{color:#dfe4f2;max-height:7.6em;overflow:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:9px}",
			"#dsh-ask-notify-card .an-body.an-empty{color:#98a0b8;font-style:italic}",
			"#dsh-ask-notify-card .an-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
			"#dsh-ask-notify-card button.an-btn{border-radius:9px;border:1px solid transparent;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer;transition:filter .15s}",
			"#dsh-ask-notify-card button.an-btn:hover{filter:brightness(1.12)}",
			"#dsh-ask-notify-card button.an-go{background:var(--an-accent);color:#131726;font-weight:600}",
			"#dsh-ask-notify-card button.an-ghost{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.12);color:#dfe4f2}",
			"#dsh-ask-notify-card button.an-ghost.an-on{background:rgba(255,176,32,.16);border-color:rgba(255,176,32,.5);color:#ffd479}",
			"#dsh-ask-notify-card .an-hint{margin-top:7px;font-size:11.5px;color:#9aa3bd;min-height:0}",
			"@media (prefers-reduced-motion:reduce){#dsh-ask-notify-card{animation:none}}"
		].join("");

		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID)) return;
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		function cardEl() {
			return document.getElementById(CARD_ID);
		}

		function setHint(text) {
			var card = cardEl();
			if (!card) {
				state.pendingHint = text;
				return;
			}
			var hint = card.querySelector(".an-hint");
			if (hint) hint.textContent = text || "";
		}

		function removeCard() {
			var card = cardEl();
			if (card && card.parentNode) card.parentNode.removeChild(card);
		}

		/** Build (or refresh) the card for the top pending wait. */
		function renderCard(item) {
			ensureStyle();
			var card = cardEl();
			var meta = KIND_META[item.kind] || KIND_META.question;
			if (!card) {
				card = document.createElement("div");
				card.id = CARD_ID;
				card.setAttribute("role", "alert");
				card.innerHTML = [
					'<div class="an-head">',
					'<span class="an-icon"></span><span class="an-title"></span>',
					'<span class="an-session"></span>',
					'<button class="an-x" type="button" title="稍后再说">×</button>',
					"</div>",
					'<div class="an-body"></div>',
					'<div class="an-actions">',
					'<button class="an-btn an-go" type="button">去回答</button>',
					'<button class="an-btn an-ghost an-later" type="button">稍后提醒</button>',
					'<button class="an-btn an-ghost an-system" type="button"></button>',
					'<button class="an-btn an-ghost an-sound" type="button"></button>',
					"</div>",
					'<div class="an-hint"></div>'
				].join("");
				document.body.appendChild(card);
				card.querySelector(".an-x").addEventListener("click", dismissCurrent);
				card.querySelector(".an-later").addEventListener("click", dismissCurrent);
				card.querySelector(".an-go").addEventListener("click", goAnswer);
				card.querySelector(".an-system").addEventListener("click", toggleSystem);
				card.querySelector(".an-sound").addEventListener("click", toggleSound);
			}
			card.style.setProperty("--an-accent", meta.accent);
			card.setAttribute("data-kind", item.kind);
			// The corner may already host the whale mascot; stack above it rather
			// than covering the decoration (+44px clears its bobbing animation).
			try {
				var whale = document.getElementById("dsh-whale-mascot-root");
				if (whale) {
					var whaleRect = whale.getBoundingClientRect();
					card.style.bottom = Math.max(18, Math.round(whaleRect.height) + 44) + "px";
				} else {
					card.style.bottom = "";
				}
			} catch (e) {}
			card.querySelector(".an-icon").textContent = meta.icon;
			card.querySelector(".an-title").textContent = meta.title;
			card.querySelector(".an-session").textContent = item.label;
			var body = card.querySelector(".an-body");
			if (item.text) {
				body.textContent = item.text.length > 400 ? item.text.slice(0, 400) + " …" : item.text;
				body.classList.remove("an-empty");
			} else {
				body.textContent = "（在下方输入框或问题卡片里作答后我才能继续）";
				body.classList.add("an-empty");
			}
			var sysBtn = card.querySelector(".an-system");
			var perm = permission();
			if (perm === "unsupported") {
				sysBtn.textContent = "桌面提醒不可用";
				sysBtn.disabled = true;
				sysBtn.title = "当前浏览器不支持 Notification";
			} else if (perm === "granted") {
				sysBtn.textContent = state.prefs.system ? "桌面提醒 开" : "桌面提醒 关";
				sysBtn.classList.toggle("an-on", state.prefs.system === true);
				sysBtn.disabled = false;
			} else {
				sysBtn.textContent = "🔔 开启桌面提醒";
				sysBtn.classList.remove("an-on");
				sysBtn.disabled = false;
			}
			var soundBtn = card.querySelector(".an-sound");
			soundBtn.textContent = state.prefs.sound ? "声音 开" : "声音 关";
			soundBtn.classList.toggle("an-on", state.prefs.sound === true);
			var hint = card.querySelector(".an-hint");
			if (state.pendingHint) {
				hint.textContent = state.pendingHint;
				state.pendingHint = null;
			} else if (perm !== "granted" && perm !== "unsupported" && !hint.textContent) {
				hint.textContent = "点「开启桌面提醒」，切到别的页面/标签时也能收到系统弹窗。";
			}
		}

		/** Re-paint the card for the current wait (after a preference change). */
		function render() {
			if (state.pending && state.dismissedKey !== state.pending.key) renderCard(state.pending);
		}

		function dismissCurrent() {
			state.pending = state.pending || collectPending()[0] || null;
			state.dismissedKey = state.pending ? state.pending.key : null;
			removeCard();
			stopTitleBlink();
		}

		function goAnswer() {
			var item = state.pending;
			try {
				var sessions = state.ctx ? state.ctx.get("sessions") : null;
				if (item && sessions && typeof sessions.open === "function") {
					var snap = sessions.list ? sessions.list.getSnapshot() : null;
					if (snap && snap.current !== item.sessionId) sessions.open(item.sessionId);
				}
			} catch (e) {}
			try {
				window.focus();
				var seat = document.querySelector("[data-composer-seat]") || document.querySelector("textarea");
				if (seat && seat.scrollIntoView) seat.scrollIntoView({ block: "center", behavior: "smooth" });
				if (seat && seat.focus) seat.focus();
			} catch (e) {}
			stopTitleBlink();
		}

		function toggleSystem() {
			var perm = permission();
			if (perm === "unsupported") return;
			if (perm !== "granted") {
				requestPermission();
				return;
			}
			state.prefs.system = !state.prefs.system;
			savePrefs();
			render();
		}

		function toggleSound() {
			state.prefs.sound = !state.prefs.sound;
			savePrefs();
			render();
		}

		/* ------------------------------------------------------------------ */
		/* the reconcile loop                                                  */
		/* ------------------------------------------------------------------ */

		/** Read the live state once and drive every channel from it. */
		function reconcile() {
			if (typeof document === "undefined") return;
			warnIfNoSource();
			var list = collectPending();
			var top = list.length > 0 ? list[0] : null;
			var previousKey = state.pending ? state.pending.key : null;
			state.pending = top;

			if (!top) {
				// A manual self-test owns the card for its short lifetime.
				if (state.selftestUntil > Date.now()) return;
				// So does the "I cannot read anything at all" notice: it is the
				// visible half of the no-silent-failure promise, and
				// clearNoticeIfWorking() takes it down the moment a source becomes
				// readable. Without this guard the very next repaint wiped it, which
				// left the plugin looking installed and doing nothing -- again.
				if (state.noticeShown === true) return;
				state.dismissedKey = null;
				state.lastSystemKey = null;
				removeCard();
				stopTitleBlink();
				return;
			}

			var away = pageIsAway();
			var isNew = top.key !== previousKey;
			if (isNew) state.dismissedKey = null;

			if (state.dismissedKey !== top.key) {
				renderCard(top);
			} else {
				removeCard();
			}

			if (away) startTitleBlink();
			else stopTitleBlink();

			if (away && state.prefs.system && top.key !== state.lastSystemKey) {
				state.lastSystemKey = top.key;
				fireSystemNotification(top);
				if (state.prefs.sound) chime();
			}
		}

		function subscribe() {
			var sessions = state.ctx ? state.ctx.get("sessions") : null;
			if (sessions && sessions.list && typeof sessions.list.subscribe === "function") {
				try {
					var dispose = sessions.list.subscribe(function () {
						reconcile();
					});
					state.subscriptions.push(dispose);
				} catch (e) {}
			}
			if (typeof document !== "undefined") {
				state.domHandler = function () {
					reconcile();
				};
				document.addEventListener("visibilitychange", state.domHandler);
				window.addEventListener("focus", state.domHandler);
				window.addEventListener("blur", state.domHandler);
				window.addEventListener("pageshow", state.domHandler);

				// Spend the first user gesture on the desktop-notification permission.
				state.gestureHandler = function () {
					document.removeEventListener("click", state.gestureHandler, true);
					document.removeEventListener("keydown", state.gestureHandler, true);
					state.gestureHandler = null;
					maybeAutoAsk();
				};
				document.addEventListener("click", state.gestureHandler, true);
				document.addEventListener("keydown", state.gestureHandler, true);
			}
		}

		function apply() {
			if (typeof document === "undefined") return;
			state.prefs = loadPrefs();

			function boot() {
				var ctx = state.ctx;
				var host = null;
				try {
					// Either service is enough to start reading. Requiring `sessions`
					// by name would silence the plugin on a harness that renamed or
					// dropped it -- exactly the failure this plugin must not have.
					host = ctx && typeof ctx.get === "function" ? ctx.get("sessions") || ctx.get("uiSession") : null;
				} catch (e) {}
				if (!host) {
					state.bootTries = (state.bootTries || 0) + 1;
					// 15s of silence is a real defect, not a slow boot: say so.
					if (state.bootTries === 30) warnIfNoSource();
					window.setTimeout(boot, 500);
					return;
				}
				subscribe();
				reconcile();
				// Belt and braces: a slow poll keeps the card honest even if a
				// subscription is missed during a reconnect.
				state.pollTimer = window.setInterval(reconcile, POLL_MS);
			}

			if (document.readyState === "loading") {
				document.addEventListener("DOMContentLoaded", boot, { once: true });
			} else {
				boot();
			}

			// Expose a small hand-test surface (also used by the plugin's selftest).
			window.__dshAskNotify = {
				version: VERSION,
				tab: TAB_ID,
				state: function () {
					return {
						pending: state.pending,
						prefs: state.prefs,
						permission: permission(),
						away: pageIsAway(),
						card: Boolean(cardEl())
					};
				},
				show: function (kind, text) {
					var meta = KIND_META[kind] ? kind : "question";
					var item = { kind: meta, text: String(text || ""), label: "(自检)", key: "selftest:" + Date.now(), sessionId: "" };
					state.dismissedKey = null;
					renderCard(item);
					startTitleBlink();
					if (state.prefs.system) fireSystemNotification(item);
					if (state.prefs.sound) chime();
					return true;
				},
				hide: function () {
					state.selftestUntil = 0;
					removeCard();
					stopTitleBlink();
					return true;
				},
				reconcile: reconcile,
				collect: function () {
					return collectPending();
				},
				sources: sources,
				selftest: function (text) {
					var holdMs = 12000;
					state.selftestUntil = Date.now() + holdMs;
					window.__dshAskNotify.show("question", text || "自检：这是右下角提醒的样子。");
					window.setTimeout(function () {
						state.selftestUntil = 0;
						if (!state.pending) {
							removeCard();
							stopTitleBlink();
						}
					}, holdMs);
					return "selftest shown for " + Math.round(holdMs / 1000) + "s";
				}
			};
		}

		function unmount() {
			stopTitleBlink();
			if (state.pollTimer !== null) window.clearInterval(state.pollTimer);
			state.pollTimer = null;
			state.subscriptions.forEach(function (dispose) {
				try {
					dispose();
				} catch (e) {}
			});
			state.subscriptions = [];
			if (state.domHandler) {
				document.removeEventListener("visibilitychange", state.domHandler);
				window.removeEventListener("focus", state.domHandler);
				window.removeEventListener("blur", state.domHandler);
				window.removeEventListener("pageshow", state.domHandler);
				state.domHandler = null;
			}
			if (state.gestureHandler) {
				document.removeEventListener("click", state.gestureHandler, true);
				document.removeEventListener("keydown", state.gestureHandler, true);
				state.gestureHandler = null;
			}
			removeCard();
			try {
				delete window.__dshAskNotify;
			} catch (e) {
				window.__dshAskNotify = undefined;
			}
		}

		// `apply(ctx)` receives the client root context. NOTHING is injected: a
		// cordis `inject` gate would stop this plugin from mounting at all if a
		// harness ever renamed or dropped that service, and a plugin that never
		// mounts cannot even complain. Services are looked up on every poll
		// instead, and a plugin that reads nothing now says so out loud.
		//
		// The same reasoning drives the deliberately EMPTY `dsh.client.inject` in
		// package.json: that list names sibling PACKAGES whose client modules must
		// load first, and the one it used to name (@deepseek-ai/dsh-client-runtime)
		// does not ship in newer harnesses -- dead weight pointing at something
		// that is not there.
		function applyWithCtx(ctx) {
			state.ctx = ctx;
			return apply();
		}

		exports.apply = applyWithCtx;
		exports.inject = [];
		exports.unmount = unmount;
		return module.exports;
	}
});
