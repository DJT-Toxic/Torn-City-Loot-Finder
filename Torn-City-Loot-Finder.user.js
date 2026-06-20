// ==UserScript==
// @name         Torn City Loot Finder
// @namespace    DJT_Toxic.city.finder.clean
// @author       DJT_Toxic
// @version      2.0.7
// @homepageURL https://github.com/DJT-Toxic/Torn-City-Loot-Finder
// @updateURL   https://raw.githubusercontent.com/DJT-Toxic/Torn-City-Loot-Finder/main/Torn-City-Loot-Finder.user.js
// @downloadURL https://raw.githubusercontent.com/DJT-Toxic/Torn-City-Loot-Finder/main/Torn-City-Loot-Finder.user.js
// @match        https://www.torn.com/city.php*
// @match        https://www.torn.com/page.php?sid=city*
// @match        https://*.torn.com/city.php*
// @match        https://*.torn.com/page.php?sid=city*
// @run-at       document-idle
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// ==/UserScript==

(() => {
    'use strict';

    const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const CFG = {
        scanMs: 1500,
        markerSize: 44,
        pickupZoom: 6,
        clickDelay: 80,
        restoreDelay: 120,
        apiKeyStore: 'tcg_city_finder_api_key',
        priceCacheStore: 'tcg_city_finder_price_cache',
        priceCacheTimeStore: 'tcg_city_finder_price_cache_time',
        priceCacheMaxAge: 12 * 60 * 60 * 1000
    };

    const state = {
        markers: new Map(),
        picked: new Set(),
        known: new Set(JSON.parse(localStorage.getItem('tcg_known_city_items') || '[]')),
        initialized: localStorage.getItem('tcg_city_initialized') === '1',
        prices: {},
        priceStatus: 'N/A',
        picking: false,
        panel: null,
        dropdownOpen: false
    };

    function ready() {
        return PAGE.torn &&
            PAGE.L &&
            PAGE.torn.map &&
            PAGE.torn.map.lmap &&
            PAGE.torn.model &&
            typeof PAGE.torn.model.get === 'function';
    }

    function waitForGame() {
        if (!ready()) {
            setTimeout(waitForGame, 1000);
            return;
        }
        init();
    }

    function items() {
        return PAGE.torn.model.get('territoryUserItems') || [];
    }

    function itemKey(item) {
        return [
            item.item_id || item.id || item.title || 'item',
            item.row_id || '',
            item.coordinates?.[0] || 0,
            item.coordinates?.[1] || 0
        ].join('_');
    }

    function itemImage(item) {
        return item.item_id ? `https://www.torn.com/images/items/${item.item_id}/small.png` : '';
    }

    function itemLatLng(item) {
        const point = [item.coordinates[0] / 2, item.coordinates[1] / 2];
        const leafletPoint = PAGE.torn.map.getLPoint(point);
        return PAGE.L.CRS.EPSG3857.pointToLatLng(leafletPoint, PAGE.torn.map.minZoom);
    }

    function apiKey() {
        return localStorage.getItem(CFG.apiKeyStore) || '';
    }

    function saveApiKey() {
        const key = prompt('Enter your Torn Public Only API key.\nStored locally only.', apiKey());
        if (key === null) return;

        const clean = key.trim();

        if (!clean) {
            localStorage.removeItem(CFG.apiKeyStore);
            clearPrices();
            redraw();
            return;
        }

        localStorage.setItem(CFG.apiKeyStore, clean);
        clearPrices();
        fetchPrices(true);
    }

    function clearPrices() {
        state.prices = {};
        state.priceStatus = 'N/A';
        localStorage.removeItem(CFG.priceCacheStore);
        localStorage.removeItem(CFG.priceCacheTimeStore);
    }

    function fetchPrices(force = false) {
        const key = apiKey();

        if (!key) {
            state.priceStatus = 'N/A';
            redraw();
            return;
        }

        if (!force) {
            try {
                const time = Number(localStorage.getItem(CFG.priceCacheTimeStore) || 0);
                if (time && Date.now() - time < CFG.priceCacheMaxAge) {
                    state.prices = JSON.parse(localStorage.getItem(CFG.priceCacheStore) || '{}');
                    state.priceStatus = Object.keys(state.prices).length ? null : 'N/A';
                    redraw();
                    return;
                }
            } catch {}
        }

        state.priceStatus = 'Loading...';
        redraw();

        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(key)}`,
            timeout: 20000,
            onload: res => {
                try {
                    const data = JSON.parse(res.responseText);

                    if (data.error) {
                        state.priceStatus = 'API error';
                        redraw();
                        return;
                    }

                    const prices = {};
                    Object.entries(data.items || {}).forEach(([id, item]) => {
                        if (typeof item.market_value === 'number') prices[id] = item.market_value;
                    });

                    state.prices = prices;
                    state.priceStatus = Object.keys(prices).length ? null : 'N/A';

                    localStorage.setItem(CFG.priceCacheStore, JSON.stringify(prices));
                    localStorage.setItem(CFG.priceCacheTimeStore, String(Date.now()));

                    redraw();
                } catch {
                    state.priceStatus = 'API error';
                    redraw();
                }
            },
            onerror: () => {
                state.priceStatus = 'API error';
                redraw();
            },
            ontimeout: () => {
                state.priceStatus = 'API timeout';
                redraw();
            }
        });
    }

    function valueOf(item) {
        const value = state.prices[String(item.item_id)];
        return typeof value === 'number' ? value : null;
    }

    function money(value) {
        if (value === null || value === undefined) return state.priceStatus || 'N/A';
        return `$${Math.round(value).toLocaleString('en-US')}`;
    }

    function esc(text) {
        return String(text || '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function injectCss() {
        const size = CFG.markerSize;

        const style = document.createElement('style');
        style.textContent = `
            .tcg-marker { background: transparent !important; border: 0 !important; }

            .tcg-box {
                position: relative;
                width: ${size + 36}px;
                height: ${size + 44}px;
                cursor: pointer;
            }

            .tcg-name {
                position: absolute;
                top: 0;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(15,15,15,.9);
                color: #ffd700;
                border: 1px solid #ffd700;
                border-radius: 7px;
                padding: 2px 6px;
                font: bold 10px Arial;
                max-width: 110px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .tcg-dot {
                position: absolute;
                top: 19px;
                left: 50%;
                transform: translateX(-50%);
                width: ${size}px;
                height: ${size}px;
                border-radius: 50%;
                background: #111;
                border: 4px solid #eee;
                box-shadow: 0 0 12px rgba(255,215,0,.65);
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            }

            .tcg-dot img {
                width: ${size}px;
                height: ${size}px;
                object-fit: contain;
                transform: scale(.65);
                filter: drop-shadow(0 0 4px #fff2a8);
                pointer-events: none;
            }

            .tcg-value {
                position: absolute;
                top: ${size + 24}px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0,0,0,.82);
                color: #8cff8c;
                border-radius: 6px;
                padding: 1px 5px;
                font: bold 10px Arial;
                white-space: nowrap;
            }

            #tcg-panel {
                position: fixed;
                top: 12px;
                right: 12px;
                z-index: 9999999;
                background: rgba(0,0,0,.72);
                color: #ffd700;
                border: 1px solid rgba(255,215,0,.55);
                border-radius: 10px;
                padding: 6px 8px;
                font: bold 11px Arial;
                text-align: center;
                cursor: default;
                opacity: .9;
                pointer-events: auto;
                user-select: none;
                backdrop-filter: blur(4px);
            }

            #tcg-panel small {
                display: block;
                margin-top: 3px;
                color: #ccc;
                font-size: 9px;
            }

            #tcg-drop-button {
                display: block;
                margin-top: 5px;
                width: 175px;
                background: rgba(0,0,0,.9);
                color: #ffd700;
                border: 1px solid rgba(255,215,0,.65);
                border-radius: 6px;
                padding: 4px;
                font: bold 10px Arial;
                cursor: pointer;
            }

            #tcg-drop-list {
                display: none;
                margin-top: 4px;
                width: 175px;
                max-height: 190px;
                overflow-y: auto;
                background: rgba(0,0,0,.96);
                border: 1px solid rgba(255,215,0,.55);
                border-radius: 6px;
                text-align: left;
            }

            #tcg-drop-list.tcg-open {
                display: block;
            }

            .tcg-drop-option {
                padding: 5px 6px;
                color: #ffd700;
                font: bold 10px Arial;
                cursor: pointer;
                border-bottom: 1px solid rgba(255,255,255,.08);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .tcg-drop-option:hover {
                background: rgba(255,215,0,.18);
            }
        `;

        document.head.appendChild(style);
    }

    function markerHtml(item) {
        const image = itemImage(item);

        return `
            <div class="tcg-box">
                <div class="tcg-name">${esc(item.title || 'Item')}</div>
                <div class="tcg-dot">
                    ${image ? `<img src="${image}" onerror="this.style.display='none'">` : '?'}
                </div>
                <div class="tcg-value">${money(valueOf(item))}</div>
            </div>
        `;
    }

    function addMarker(item) {
        if (!item.coordinates || item.coordinates.length < 2) return;

        const key = itemKey(item);
        if (state.picked.has(key) || state.markers.has(key)) return;

        const size = CFG.markerSize;
        const width = size + 36;
        const height = size + 44;

        const icon = PAGE.L.divIcon({
            className: 'tcg-marker',
            html: markerHtml(item),
            iconSize: [width, height],
            iconAnchor: [width / 2, height - 2]
        });

        const marker = PAGE.L.marker(itemLatLng(item), {
            icon,
            interactive: true,
            keyboard: false,
            zIndexOffset: 999999
        }).addTo(PAGE.torn.map.lmap);

        marker.on('click', e => {
            e?.originalEvent?.preventDefault?.();
            e?.originalEvent?.stopPropagation?.();
            pickup(item, key);
        });

        state.markers.set(key, marker);
    }

    function removeMarker(key) {
        const marker = state.markers.get(key);
        if (!marker) return;

        try {
            PAGE.torn.map.lmap.removeLayer(marker);
        } catch {}

        state.markers.delete(key);
    }

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'tcg-panel';

        panel.addEventListener('click', e => {
            e.stopPropagation();
        });

        panel.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            localStorage.removeItem(CFG.apiKeyStore);
            clearPrices();
            redraw();
        });

        document.addEventListener('click', e => {
            if (!state.panel) return;
            if (!state.panel.contains(e.target)) {
                state.dropdownOpen = false;
                updatePanel(items());
            }
        }, true);

        document.body.appendChild(panel);
        state.panel = panel;
    }

    function zoomToItem(key) {
        const item = items().find(i => itemKey(i) === key);
        if (!item) return;

        PAGE.torn.map.lmap.setView(itemLatLng(item), CFG.pickupZoom, { animate: true });
    }

    function updatePanel(list) {
        if (!state.panel) createPanel();

        const visible = list.filter(item => !state.picked.has(itemKey(item)));

        let total = 0;
        let hasValue = false;

        visible.forEach(item => {
            const value = valueOf(item);
            if (value !== null) {
                total += value;
                hasValue = true;
            }
        });

        const options = visible.map(item => {
            const key = esc(itemKey(item));
            const name = esc(item.title || 'Item');
            const value = valueOf(item);
            const label = value !== null ? `${name} - ${money(value)}` : name;

            return `<div class="tcg-drop-option" data-key="${key}" title="${label}">${label}</div>`;
        }).join('');

        state.panel.innerHTML = `
            <div>Items: ${visible.length}</div>
            <div>Value: ${money(hasValue ? total : null)}</div>

            <button id="tcg-drop-button" type="button">Jump to item...</button>

            <div id="tcg-drop-list" class="${state.dropdownOpen ? 'tcg-open' : ''}">
                ${options || '<div class="tcg-drop-option">No items</div>'}
            </div>

            <small>${apiKey() ? 'Right-click: remove API key' : 'Double-click panel: set API key'}</small>
        `;

        const button = state.panel.querySelector('#tcg-drop-button');
        const optionEls = state.panel.querySelectorAll('.tcg-drop-option[data-key]');

        button.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            state.dropdownOpen = !state.dropdownOpen;
            updatePanel(items());
        };

        optionEls.forEach(option => {
            option.onclick = e => {
                e.preventDefault();
                e.stopPropagation();

                state.dropdownOpen = false;
                zoomToItem(option.dataset.key);
                updatePanel(items());
            };
        });

        state.panel.ondblclick = e => {
            e.preventDefault();
            e.stopPropagation();
            saveApiKey();
        };
    }

    function sync() {
        const list = items();
        const live = new Set(list.map(itemKey));

        list.forEach(addMarker);

        for (const key of state.markers.keys()) {
            if (!live.has(key) || state.picked.has(key)) {
                removeMarker(key);
            }
        }

        updatePanel(list);
        detectNew(list);
    }

    function redraw() {
        [...state.markers.keys()].forEach(removeMarker);
        sync();
    }

    function detectNew(list) {
        if (!state.initialized) {
            list.forEach(item => state.known.add(itemKey(item)));
            localStorage.setItem('tcg_known_city_items', JSON.stringify([...state.known]));
            localStorage.setItem('tcg_city_initialized', '1');
            state.initialized = true;
            return;
        }

        const fresh = list.filter(item => !state.known.has(itemKey(item)));
        if (!fresh.length) return;

        fresh.forEach(item => state.known.add(itemKey(item)));
        localStorage.setItem('tcg_known_city_items', JSON.stringify([...state.known]));

        notify(`New city item: ${fresh.map(i => i.title || 'Item').join(', ')}`);
    }

    function notify(text) {
        try {
            GM_notification({
                title: 'Torn City Finder',
                text,
                timeout: 4000
            });
        } catch {}

        console.log('TCG:', text);
    }

    function pickup(item, key) {
        if (state.picking) return;
        state.picking = true;

        const map = PAGE.torn.map.lmap;
        const latlng = itemLatLng(item);
        const oldCenter = map.getCenter();
        const oldZoom = map.getZoom();

        state.picked.add(key);
        removeMarker(key);
        updatePanel(items());

        try {
            map.setView(latlng, CFG.pickupZoom, { animate: false });

            setTimeout(() => {
                const point = map.latLngToContainerPoint(latlng);
                const rect = map.getContainer().getBoundingClientRect();
                const x = rect.left + point.x;
                const y = rect.top + point.y;
                const target = document.elementFromPoint(x, y);

                if (target) {
                    const opts = {
                        bubbles: true,
                        cancelable: true,
                        clientX: x,
                        clientY: y,
                        view: window
                    };

                    ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'].forEach(type => {
                        target.dispatchEvent(new MouseEvent(type, opts));
                    });
                }

                setTimeout(() => {
                    map.setView(oldCenter, oldZoom, { animate: false });
                    state.picking = false;
                    sync();
                }, CFG.restoreDelay);
            }, CFG.clickDelay);
        } catch (e) {
            console.warn('TCG pickup failed:', e);
            state.picking = false;
        }
    }

    function init() {
        injectCss();
        createPanel();
        sync();
        fetchPrices(false);

        setInterval(() => {
            if (!state.picking) sync();
        }, CFG.scanMs);

        console.log('Torn City Finder v2.0.4 loaded');
    }

    waitForGame();
})();
