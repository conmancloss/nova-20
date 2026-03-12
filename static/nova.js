document.addEventListener('DOMContentLoaded', () => {

	// ── Shared state ───────────────────────────────────────────────
	const urlBar   = document.getElementById("url-bar");
	const loading  = document.getElementById("loading");
	const searchIn = document.getElementById("search-input");
	let _frame = null, _pendingNav = null;

	// ── Toast ──────────────────────────────────────────────────────
	function toast(msg, duration = 2800) {
		const el = document.createElement("div");
		el.className = "toast";
		el.textContent = msg;
		document.getElementById("toast-container").appendChild(el);
		setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, duration);
	}

	// ── Theme ──────────────────────────────────────────────────────
	function applyTheme(t) {
		document.documentElement.setAttribute("data-theme", t);
		localStorage.setItem("nova_theme", t);
		document.querySelectorAll(".theme-opt").forEach(b => b.classList.toggle("active", b.dataset.themeVal === t));
	}
	applyTheme(localStorage.getItem("nova_theme") || "dark");
	document.querySelectorAll(".theme-opt").forEach(b => b.addEventListener("click", () => applyTheme(b.dataset.themeVal)));

	// ── What's New ─────────────────────────────────────────────────
	fetch("/whats-new.json")
		.then(r => r.json())
		.then(wn => {
			if (localStorage.getItem("nova_seen_version") === wn.version) return;
			document.querySelector(".wn-title").textContent = wn.title;
			const list = document.querySelector(".wn-list");
			list.innerHTML = "";
			wn.items.forEach(item => {
				const li = document.createElement("li");
				li.innerHTML = `<span class="icon">${item.icon}</span><span>${item.text}</span>`;
				list.appendChild(li);
			});
			document.getElementById("whats-new-overlay").classList.remove("hidden");
			document.getElementById("wn-close-btn").addEventListener("click", () => {
				localStorage.setItem("nova_seen_version", wn.version);
				document.getElementById("whats-new-overlay").classList.add("hidden");
			});
		})
		.catch(() => {});

	// ── URL helper ─────────────────────────────────────────────────
	function resolveURL(input) {
		input = input.trim();
		if (!input) return null;
		if (/^https?:\/\//i.test(input)) return input;
		if (/^[\w-]+(\.[a-z]{2,})(\/.*)?$/i.test(input)) return "https://" + input;
		return "https://www.google.com/search?q=" + encodeURIComponent(input);
	}

	// ── Page switcher ──────────────────────────────────────────────
	function switchPage(name) {
		document.querySelectorAll(".nav-tab").forEach(x => x.classList.toggle("active", x.dataset.page === name));
		document.querySelectorAll(".page").forEach(x => x.classList.toggle("active", x.id === "page-" + name));
		if (name === "home") {
			const inner = document.querySelector(".home-inner");
			inner.classList.remove("animate");
			requestAnimationFrame(() => requestAnimationFrame(() => inner.classList.add("animate")));
		}
		if (name === "games") maybeLoadGames();
	}
	document.querySelectorAll(".nav-tab").forEach(t => t.addEventListener("click", () => switchPage(t.dataset.page)));
	requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(".home-inner").classList.add("animate")));

	// ── navigate() ────────────────────────────────────────────────
	function navigate(url) {
		const r = resolveURL(url);
		if (!r) return;
		switchPage("browser");
		urlBar.value = r;
		searchIn.value = "";
		if (_frame) { _frame.go(r); }
		else { _pendingNav = r; }
	}
	window.goTo = navigate;

	// ── Search + URL bar ───────────────────────────────────────────
	searchIn.addEventListener("keydown", e => { if (e.key === "Enter") { navigate(searchIn.value); searchIn.blur(); } });
	document.getElementById("go-btn").addEventListener("click", () => navigate(searchIn.value));
	urlBar.addEventListener("keydown", e => { if (e.key === "Enter") { navigate(urlBar.value); urlBar.blur(); } });

	// ── Home Shortcuts (hardcoded) ─────────────────────────────────
	const SHORTCUTS = [
		{ label: "Google",    url: "https://google.com",    emoji: "🔍" },
		{ label: "YouTube",   url: "https://youtube.com",   emoji: "▶️" },
		{ label: "Reddit",    url: "https://reddit.com",    emoji: "🤖" },
		{ label: "Discord",   url: "https://discord.com",   emoji: "💬" },
		{ label: "Instagram", url: "https://instagram.com", emoji: "📸" },
		{ label: "Twitter",   url: "https://twitter.com",   emoji: "🐦" },
		{ label: "Spotify",   url: "https://spotify.com",   emoji: "🎵" },
		{ label: "GitHub",    url: "https://github.com",    emoji: "🐙" },
	];
	(function renderShortcuts() {
		const row = document.getElementById("shortcuts-row");
		if (!row) return;
		row.innerHTML = "";
		SHORTCUTS.forEach(s => {
			const btn = document.createElement("button");
			btn.className = "shortcut-btn";
			btn.innerHTML = `<span class="sc-emoji">${s.emoji}</span><span class="sc-label">${s.label}</span>`;
			btn.addEventListener("click", () => navigate(s.url));
			row.appendChild(btn);
		});
	})();

	// ── About Blank Mode ───────────────────────────────────────────
	// State is persisted in localStorage. On load, toggle reflects saved state.
	// Changing the toggle saves the new state and shows a toast — actual
	// about:blank window opens on next page load/refresh.
	const abToggle = document.getElementById("ab-mode-toggle");
	const AB_KEY = "nova_ab_mode";

	// Restore saved state on load
	abToggle.checked = localStorage.getItem(AB_KEY) === "1";

	// If ab mode is ON and we're not inside a blob/about:blank, open the cloak window
	// (This runs on every load so refreshing inside the cloaked window keeps working)
	(function maybeOpenAB() {
		if (localStorage.getItem(AB_KEY) !== "1") return;
		// Already inside a blob iframe? Don't recurse
		if (location.protocol === "blob:" || window.parent !== window) return;

		const base = location.href.split("?")[0];
		const html =
			'<!doctype html><html><head>' +
			'<title>New Tab</title>' +
			'<style>' +
			'*{margin:0;padding:0;box-sizing:border-box}' +
			'html,body{width:100%;height:100%;overflow:hidden;background:#000}' +
			'iframe{position:fixed;inset:0;width:100%;height:100%;border:none}' +
			'</style></head><body>' +
			'<iframe src="' + base + '" allowfullscreen></iframe>' +
			'</body></html>';

		const blob = new Blob([html], { type: 'text/html' });
		const blobURL = URL.createObjectURL(blob);
		const w = window.open(blobURL, '_blank');
		if (w) {
			setTimeout(() => URL.revokeObjectURL(blobURL), 5000);
			// Replace this tab's URL with Google Classroom so the origin isn't visible
			window.location.replace("https://classroom.google.com");
		} else {
			URL.revokeObjectURL(blobURL);
		}
	})();

	abToggle.addEventListener("change", () => {
		const isOn = abToggle.checked;
		localStorage.setItem(AB_KEY, isOn ? "1" : "0");
		if (isOn) {
			toast("About Blank ON — takes effect on next refresh");
		} else {
			toast("About Blank OFF — takes effect on next refresh");
		}
	});

	// ── Homepage setting ───────────────────────────────────────────
	const homepageInput = document.getElementById("homepage-input");
	homepageInput.value = localStorage.getItem("nova_homepage") || "";
	homepageInput.addEventListener("change", () => {
		const val = homepageInput.value.trim();
		if (val) { localStorage.setItem("nova_homepage", val); toast("Homepage saved"); }
	});

	// ── Panic key ──────────────────────────────────────────────────
	let panicKey = localStorage.getItem("nova_panic_key") || "p";
	let panicURL = localStorage.getItem("nova_panic_url") || "https://classroom.google.com";
	const keyDisplay    = document.getElementById("key-display");
	const keyChangeBtn  = document.getElementById("key-change-btn");
	const panicURLInput = document.getElementById("panic-url-input");
	keyDisplay.textContent = panicKey.toUpperCase();
	panicURLInput.value = panicURL;
	panicURLInput.addEventListener("change", () => {
		const val = panicURLInput.value.trim();
		if (val) { panicURL = val; localStorage.setItem("nova_panic_url", val); toast("Panic URL saved"); }
	});
	let listening = false;
	keyChangeBtn.addEventListener("click", () => {
		listening = true;
		keyChangeBtn.textContent = "Press a key...";
		keyChangeBtn.classList.add("listening");
	});
	document.addEventListener("keydown", e => {
		if (listening) {
			if (e.key === "Escape") {
				listening = false;
				keyChangeBtn.textContent = "Change";
				keyChangeBtn.classList.remove("listening");
				return;
			}
			panicKey = e.key.toLowerCase();
			localStorage.setItem("nova_panic_key", panicKey);
			keyDisplay.textContent = e.key.toUpperCase();
			listening = false;
			keyChangeBtn.textContent = "Change";
			keyChangeBtn.classList.remove("listening");
			toast("Panic key set to " + e.key.toUpperCase());
			return;
		}
		// Escape exits fullscreen
		if (e.key === "Escape" && isFullscreen) {
			exitFullscreen();
			return;
		}
		const tag = document.activeElement?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
		if (e.key.toLowerCase() === panicKey) window.location.href = panicURL;
	});
	document.getElementById("panic-btn").addEventListener("click", () => { window.location.href = panicURL; });

	// ── Fullscreen state (used by Escape key fallback) ─────────────
	let isFullscreen = false;

	const fsBtn   = document.getElementById("fullscreen-btn");
	const shell   = document.getElementById("shell");
	const fsIconExpand   = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
	const fsIconCollapse = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;
	fsBtn.innerHTML = fsIconExpand;

	function enterFullscreen() {
		isFullscreen = true;
		shell.classList.add("fullscreen");
		fsBtn.innerHTML = fsIconCollapse;
		fsBtn.title = "Exit fullscreen (Esc)";
	}

	function exitFullscreen() {
		isFullscreen = false;
		shell.classList.remove("fullscreen");
		// Explicitly clear any inline display overrides so nav is always visible
		const nav = shell.querySelector(".top-nav");
		const bar = shell.querySelector(".browser-bar");
		if (nav) { nav.style.display = ""; nav.style.visibility = ""; nav.style.opacity = ""; }
		if (bar) { bar.style.display = ""; bar.style.visibility = ""; bar.style.opacity = ""; }
		fsBtn.innerHTML = fsIconExpand;
		fsBtn.title = "Fullscreen";
	}

	fsBtn.addEventListener("click", () => {
		if (isFullscreen) { exitFullscreen(); } else { enterFullscreen(); }
	})

	// ── Games ──────────────────────────────────────────────────────
	let _allGames = [];
	let _favs = new Set(JSON.parse(localStorage.getItem("nova_favs") || "[]"));
	function saveFavs() { localStorage.setItem("nova_favs", JSON.stringify([..._favs])); }

	function makeGameCard(g, isFav) {
		const div = document.createElement("div");
		div.className = "game-card";
		div.innerHTML = `
			<button class="fav-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Unfavorite' : 'Favorite'}">⭐</button>
			<img src="${g.image}" loading="lazy" onerror="this.style.display='none'" />
			<div class="game-name">${g.name}</div>
		`;
		div.querySelector(".fav-btn").addEventListener("click", ev => {
			ev.stopPropagation();
			if (_favs.has(g.name)) { _favs.delete(g.name); toast("Removed from favorites"); }
			else { _favs.add(g.name); toast("Added to favorites ⭐"); }
			saveFavs(); renderGames(_currentQuery);
		});
		div.addEventListener("click", () => goTo(g.url));
		return div;
	}

	function makeSkeleton(n) {
		const f = document.createDocumentFragment();
		for (let i = 0; i < n; i++) {
			const d = document.createElement("div");
			d.className = "game-skeleton";
			d.innerHTML = '<div class="skel-img"></div><div class="skel-name"></div>';
			f.appendChild(d);
		}
		return f;
	}

	let _currentQuery = "";
	function renderGames(query) {
		_currentQuery = query;
		const q = query.trim().toLowerCase();
		const filtered = q ? _allGames.filter(g => g.name.toLowerCase().includes(q)) : _allGames;
		const favs = filtered.filter(g => _favs.has(g.name));
		const rest  = filtered.filter(g => !_favs.has(g.name));
		const favSection = document.getElementById("fav-section");
		const favGrid    = document.getElementById("fav-grid");
		const grid       = document.getElementById("game-grid");
		if (favs.length && !q) {
			favSection.style.display = "block"; favGrid.innerHTML = "";
			favs.forEach(g => favGrid.appendChild(makeGameCard(g, true)));
		} else { favSection.style.display = "none"; }
		if (!filtered.length) { grid.innerHTML = "<div class='games-empty'>No games found.</div>"; return; }
		grid.innerHTML = "";
		(q ? filtered : rest).forEach(g => grid.appendChild(makeGameCard(g, _favs.has(g.name))));
	}

	let _gamesLoaded = false;
	function maybeLoadGames() {
		if (_gamesLoaded) return;
		_gamesLoaded = true;
		const grid = document.getElementById("game-grid");
		const progressWrap = document.getElementById("games-progress-wrap");
		const progressBar  = document.getElementById("games-progress-bar");
		const subtitle = document.getElementById("games-subtitle");

		grid.innerHTML = ""; grid.appendChild(makeSkeleton(24));
		progressWrap.classList.remove("hidden");
		progressBar.style.width = "15%";

		let prog = 15;
		const ticker = setInterval(() => {
			prog = Math.min(prog + Math.random() * 12, 85);
			progressBar.style.width = prog + "%";
		}, 200);

		fetch("/games.json")
			.then(r => r.json())
			.then(games => {
				clearInterval(ticker);
				progressBar.style.width = "100%";
				_allGames = games;
				subtitle.textContent = `${games.length} games — play anywhere, anytime`;
				setTimeout(() => {
					progressWrap.classList.add("hidden");
					progressBar.style.width = "0%";
					renderGames("");
				}, 300);
			})
			.catch(() => {
				clearInterval(ticker);
				progressWrap.classList.add("hidden");
				grid.innerHTML = "<div style='color:var(--muted);padding:2rem'>Failed to load games.</div>";
			});
	}
	document.getElementById("game-search").addEventListener("input", function() { renderGames(this.value); });

	// ── Save data ──────────────────────────────────────────────────
	document.getElementById("download-save-btn").addEventListener("click", () => {
		const data = {};
		for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); data[k] = localStorage.getItem(k); }
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
		a.download = "nova-save-" + new Date().toISOString().slice(0,10) + ".json";
		a.click(); URL.revokeObjectURL(a.href);
		toast("Save data downloaded 💾");
	});
	document.getElementById("upload-save-btn").addEventListener("click", () => document.getElementById("save-file-input").click());
	document.getElementById("save-file-input").addEventListener("change", function() {
		const file = this.files[0]; if (!file) return;
		const reader = new FileReader();
		reader.onload = e => {
			try {
				const data = JSON.parse(e.target.result);
				let count = 0;
				for (const [k, v] of Object.entries(data)) { localStorage.setItem(k, v); count++; }
				if (data.nova_panic_key) { panicKey = data.nova_panic_key; keyDisplay.textContent = panicKey.toUpperCase(); }
				if (data.nova_panic_url) { panicURL = data.nova_panic_url; panicURLInput.value = panicURL; }
				if (data.nova_homepage) homepageInput.value = data.nova_homepage;
				if (data.nova_theme) applyTheme(data.nova_theme);
				if (data.nova_favs) { _favs = new Set(JSON.parse(data.nova_favs)); renderGames(_currentQuery); }
				toast("Restored " + count + " setting" + (count !== 1 ? "s" : "") + " ✓");
			} catch { toast("Invalid save file ✗"); }
		};
		reader.readAsText(file); this.value = "";
	});

	window.addEventListener("load", () => searchIn.focus());

	// ── UV Proxy init ──────────────────────────────────────────────
	(async () => {
		try {
			const swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
			await navigator.serviceWorker.ready;
			if (swReg.waiting) {
				swReg.waiting.postMessage({ type: "SKIP_WAITING" });
				await new Promise(r => setTimeout(r, 300));
			}

			const iframe = document.createElement("iframe");
			iframe.style.cssText = "width:100%;height:100%;border:none;";
			document.getElementById("frame-container").appendChild(iframe);

			const loadingBar = document.getElementById("loading-bar");
			let loadingTimer = null;
			let loadingTicker = null;
			let loadingProg = 0;

			function showLoading() {
				clearTimeout(loadingTimer);
				clearInterval(loadingTicker);
				loadingProg = 0;
				loadingBar.style.transition = "none";
				loadingBar.style.width = "0%";
				loading.classList.add("show");

				// Small delay then kick off — gives transition:"none" time to apply
				requestAnimationFrame(() => requestAnimationFrame(() => {
					loadingBar.style.transition = "width .3s ease";
					loadingBar.style.width = "20%";
					loadingProg = 20;

					loadingTicker = setInterval(() => {
						// Asymptotic crawl — fast at start, slows as it approaches 90%
						const remaining = 90 - loadingProg;
						loadingProg += remaining * 0.08 + Math.random() * 2;
						loadingProg = Math.min(loadingProg, 90);
						loadingBar.style.width = loadingProg + "%";
					}, 400);
				}));

				// Hard timeout fallback — force complete after 12s
				loadingTimer = setTimeout(() => hideLoading(), 12000);
			}

			function hideLoading() {
				clearTimeout(loadingTimer);
				clearInterval(loadingTicker);
				// Snap to 100% then fade out
				loadingBar.style.transition = "width .2s ease";
				loadingBar.style.width = "100%";
				setTimeout(() => {
					loading.classList.remove("show");
					setTimeout(() => {
						loadingBar.style.transition = "none";
						loadingBar.style.width = "0%";
					}, 150);
				}, 200);
			}

			iframe.addEventListener("load", () => {
				hideLoading();
				try {
					const src = iframe.src || "";
					if (!src || src === "about:blank") return;
					if (src.includes(__uv$config.prefix)) {
						const encoded = src.split(__uv$config.prefix)[1];
						if (!encoded) return;
						const decoded = __uv$config.decodeUrl(encoded.split(/[?#]/)[0]);
						if (decoded && decoded !== urlBar.value) {
							urlBar.value = decoded;
							window.history.replaceState({ proxyUrl: decoded }, "", "?q=" + encodeURIComponent(decoded));
						}
					}
				} catch(_) {}
			});

			function uvNavigate(url) {
				if (!url) return;
				// ── Check blocked list before navigating ──────────────────
				const cleanInput = url.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
				if (window._novaBlockedUrls && window._novaBlockedUrls.length) {
					const hit = window._novaBlockedUrls.find(b => {
						const bUrl = b.url.toLowerCase();
						return cleanInput === bUrl ||
							cleanInput.startsWith(bUrl + "/") ||
							cleanInput.startsWith(bUrl + "?");
					});
					if (hit) {
						hideLoading();
						urlBar.value = url;
						document.getElementById("frame-container").innerHTML =
							`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);gap:.75rem;padding:2rem;text-align:center;">
								<div style="font-size:2.5rem">🚫</div>
								<div style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:.14em;color:var(--text)">ACCESS BLOCKED</div>
								<div style="font-size:.78rem;color:var(--muted);max-width:320px;line-height:1.5">${hit.reason ? hit.reason : "This URL has been blocked by an administrator."}</div>
								<div style="font-size:.66rem;color:var(--dim);font-family:monospace;margin-top:.3rem">${url}</div>
							</div>`;
						return;
					}
				}
				// ─────────────────────────────────────────────────────────
				showLoading();
				urlBar.value = url;
				window.history.pushState({ proxyUrl: url }, "", "?q=" + encodeURIComponent(url));
				try { iframe.src = __uv$config.prefix + __uv$config.encodeUrl(url); }
				catch(e) { console.error("UV encode error:", e); iframe.src = url; }
			}

			window.addEventListener("popstate", e => { if (e.state?.proxyUrl) uvNavigate(e.state.proxyUrl); });

			const initParam = new URLSearchParams(location.search).get("q");
			if (initParam) urlBar.value = initParam;

			// Load homepage on browser tab open if set
			const hp = localStorage.getItem("nova_homepage");

			_frame = {
				frame: iframe,
				go(url)   { uvNavigate(url); },
				back()    { try { iframe.contentWindow.history.back(); }    catch(e) { history.back(); } },
				forward() { try { iframe.contentWindow.history.forward(); } catch(e) { history.forward(); } },
				reload()  { showLoading(); try { iframe.contentWindow.location.reload(); } catch(e) { iframe.src = iframe.src; } },
				currentUrl() { return urlBar.value || ""; },
				currentProxySrc() {
					try {
						const s = iframe.src;
						if (s && s.includes(__uv$config.prefix)) return s;
					} catch(_) {}
					// Fallback: encode current URL
					const u = urlBar.value;
					if (u) {
						try { return __uv$config.prefix + __uv$config.encodeUrl(u); }
						catch(_) {}
					}
					return null;
				},
			};

			document.getElementById("back-btn").addEventListener("click",   () => _frame.back());
			document.getElementById("fwd-btn").addEventListener("click",    () => _frame.forward());
			document.getElementById("reload-btn").addEventListener("click", () => _frame.reload());

			// Fullscreen handler is set up at top level (see below the UV block)

			if (_pendingNav) { _frame.go(_pendingNav); _pendingNav = null; }
			else if (hp && initParam === null) {
				// Navigate to homepage when first opening the browser tab with no query
				_frame.go(hp);
			}

		} catch (err) {
			console.error("Nova proxy init failed:", err);
			loading.classList.remove("show");
			document.getElementById("frame-container").innerHTML = `<div style="color:var(--muted);padding:2rem;font-size:.8rem;letter-spacing:.1em">Proxy unavailable.<br><br><code style="color:var(--dim)">${err.message}</code></div>`;
		}
	})();

});

// ── View counter ───────────────────────────────────────────────
(function() {
	// Fire a view hit on every page load
	fetch('/api/views', { method: 'POST' })
		.then(r => r.json())
		.then(function(v) {
			// Update the analytics display in settings if visible
			updateViewBadges(v);
		})
		.catch(function() {});

	function fmt(n) {
		if (n === undefined || n === null) return '—';
		if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
		if (n >= 1000) return (n/1000).toFixed(1) + 'K';
		return String(n);
	}

	function updateViewBadges(v) {
		var total = document.getElementById('views-total');
		var today = document.getElementById('views-today');
		if (total) total.textContent = fmt(v.total);
		if (today) today.textContent = fmt(v.today);
	}

	// Also refresh counts when settings tab is opened
	document.addEventListener('DOMContentLoaded', function() {
		document.querySelectorAll('.nav-tab').forEach(function(tab) {
			tab.addEventListener('click', function() {
				if (tab.dataset.page === 'settings') {
					fetch('/api/views')
						.then(function(r) { return r.json(); })
						.then(updateViewBadges)
						.catch(function() {});
				}
			});
		});
	});
})();

// ── Broadcast Banner ────────────────────────────────────────────────────────
(function() {
	var DISMISSED_KEY = 'nova:broadcast-dismissed';

	function showBanner(text, date) {
		var banner = document.getElementById('broadcast-banner');
		var textEl = document.getElementById('broadcast-banner-text');
		if (!banner || !textEl) return;
		// If user already dismissed this exact message, don't show again
		var dismissed = localStorage.getItem(DISMISSED_KEY);
		if (dismissed === (text + date)) return;
		textEl.textContent = text;
		banner.style.display = 'flex';
		// Push shell down so content isn't hidden under banner
		var shell = document.getElementById('shell');
		if (shell) shell.style.paddingTop = banner.offsetHeight + 'px';
	}

	function hideBanner() {
		var banner = document.getElementById('broadcast-banner');
		if (!banner) return;
		banner.style.display = 'none';
		var shell = document.getElementById('shell');
		if (shell) shell.style.paddingTop = '';
	}

	function checkBroadcast() {
		fetch('/api/broadcast')
			.then(function(r) { return r.json(); })
			.then(function(data) {
				if (data && data.text) {
					showBanner(data.text, data.date || '');
				} else {
					hideBanner();
				}
			})
			.catch(function() {});
	}

	// Wire up close button — also saves dismissal so it won't re-appear
	document.addEventListener('DOMContentLoaded', function() {
		var closeBtn = document.getElementById('broadcast-banner-close');
		if (closeBtn) {
			closeBtn.addEventListener('click', function() {
				var banner = document.getElementById('broadcast-banner');
				var textEl = document.getElementById('broadcast-banner-text');
				if (banner && textEl) {
					// Remember this specific message was dismissed
					var dismissed_date = banner.dataset.broadcastDate || '';
					localStorage.setItem(DISMISSED_KEY, textEl.textContent + dismissed_date);
				}
				hideBanner();
			});
		}
		checkBroadcast();
	});

	// Poll every 60 seconds so new broadcasts appear without a full reload
	setInterval(checkBroadcast, 60000);
})();

// ── Blocked URL cache ────────────────────────────────────────────────────────
// Fetched once on load and refreshed every 2 minutes so proxy checks are instant
(function() {
	function fetchBlocked() {
		fetch('/api/blocked')
			.then(function(r) { return r.json(); })
			.then(function(list) { window._novaBlockedUrls = Array.isArray(list) ? list : []; })
			.catch(function() { window._novaBlockedUrls = window._novaBlockedUrls || []; });
	}
	fetchBlocked();
	setInterval(fetchBlocked, 120000);
})();
