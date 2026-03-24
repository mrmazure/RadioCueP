/**
 * RadioCueP - Core Logic
 */

// --- Constants ---
let PIXELS_PER_SECOND = 15;
const PLAYHEAD_PERCENT = 0.25;
const MAX_UNDO = 30;

// --- Block Types (mutable) ---
let blockTypes = [
    { id: 'music',     name: 'Musique',    color: '#9333ea', icon: '🎵' },
    { id: 'interview', name: 'Chronique',  color: '#e11d48', icon: '🎙' },
    { id: 'jingle',    name: 'Jingle',     color: '#22c55e', icon: '🔔' },
    { id: 'spoken',    name: 'Flash',      color: '#6366f1', icon: '⚡' },
    { id: 'ads',       name: 'Publicité',  color: '#ca8a04', icon: '💰' },
    { id: 'other',     name: 'Autre',      color: '#52525b', icon: '📝' },
];

// Anciens noms anglais → nouveaux noms français (migration localStorage / JSON importé)
const LEGACY_TYPE_NAMES = {
    music:     { name: 'Music',     icon: '🎵' },
    interview: { name: 'Interview', icon: '🎙' },
    jingle:    { name: 'Jingle',    icon: '🔔' },
    spoken:    { name: 'Spoken',    icon: '🗣'  },
    ads:       { name: 'Ads',       icon: '💰' },
    other:     { name: 'Other',     icon: '📝' },
};
const CURRENT_TYPE_DEFAULTS = {
    music:     { name: 'Musique',   icon: '🎵' },
    interview: { name: 'Chronique', icon: '🎙' },
    jingle:    { name: 'Jingle',    icon: '🔔' },
    spoken:    { name: 'Flash',     icon: '⚡'  },
    ads:       { name: 'Publicité', icon: '💰' },
    other:     { name: 'Autre',     icon: '📝' },
};

function migrateBlockTypes(types) {
    return types.map(t => {
        const legacy = LEGACY_TYPE_NAMES[t.id];
        const current = CURRENT_TYPE_DEFAULTS[t.id];
        if (legacy && current && t.name === legacy.name) {
            return { ...t, name: current.name, icon: legacy.icon === t.icon ? current.icon : t.icon };
        }
        return t;
    });
}

// --- State ---
let blocks = [];
let isPlaying = false;
let currentElapsedSeconds = 0;
let lastTimeMs = performance.now();
let rafId = null;
let currentBlockIndex = -1;
let autoPauseEnabled = false;

function advanceTime() {
    const now = performance.now();
    const delta = (now - lastTimeMs) / 1000;
    lastTimeMs = now;
    if (isPlaying) {
        currentElapsedSeconds += delta;
        updateStatusPanel();
    }
}

// Show metadata
let showName = '';

// Undo/Redo
let undoStack = [];
let redoStack = [];

// Zoom
let zoomFactor = 1.0;

// PeerJS
let myPeerId = null;
let peerInitialized = false;
let pendingLiveWindow = false;
let pendingLiveLink = false;

// Mirror dead-reckoning
let mirrorMasterElapsed = 0;
let mirrorReceivedAt    = 0;

// Auto-save
let autoSaveTimer = null;

// Emoji picker
let emojiPickerCallback = null;
let newTypeIconValue    = '📝';

// --- DOM ---
const jsonFileIn        = document.getElementById('jsonFile');
const timelineContainer = document.getElementById('timeline-container');
const timelineTrack     = document.getElementById('timelineTrack');
const timelineGrads     = document.getElementById('timelineGraduations');
const progressBar       = document.getElementById('progressBar');

const curIcon        = document.getElementById('curIcon');
const curType        = document.getElementById('curType');
const curName        = document.getElementById('curName');
const xxlCountdown   = document.getElementById('xxlCountdown');
const totalRemaining = document.getElementById('totalRemaining');
const nextBlockEl    = document.getElementById('nextBlock');
const zoomLabel      = document.getElementById('zoomLabel');

const btnPlay    = document.getElementById('btnPlay');
const btnPause   = document.getElementById('btnPause');
const btnReset   = document.getElementById('btnReset');
const btnNext    = document.getElementById('btnNext');
const btnUndo    = document.getElementById('btnUndo');
const btnRedo    = document.getElementById('btnRedo');
const zoomInBtn  = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');

const listView    = document.getElementById('listView');
const editorStats = document.getElementById('editorStats');
const btnAddBlock = document.getElementById('addBlockBtn');
const peerStatus  = document.getElementById('peerStatus');

let draggedIndex = null;

// PeerJS state
const urlParams    = new URLSearchParams(window.location.search);
const isMirror     = urlParams.has('mirror');
const mirrorTarget = urlParams.get('mirror');
let peer = null;
let mirrorConn = null;
const mirrorClients = [];

// =============================================================
// HELPERS
// =============================================================
function getBlockType(typeId) {
    return blockTypes.find(t => t.id === (typeId || '').toLowerCase())
        || blockTypes.find(t => t.id === 'other')
        || blockTypes[blockTypes.length - 1];
}

function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        if (blocks.length > 0) {
            localStorage.setItem('radiocuep_save', JSON.stringify({ showName, blocks, blockTypes }));
        }
    }, 800);
}

// =============================================================
// INITIALIZATION
// =============================================================
function init() {
    blocks = [];
    currentBlockIndex = -1;
    currentElapsedSeconds = 0;
    isPlaying = false;

    drawGraduations();

    window.addEventListener('resize', () => {
        if (isPlaying || blocks.length > 0) updateTimelineVisuals();
        drawGraduations();
    });

    initMenuDropdown();
    initModals();

    // Mirror mode must connect immediately; normal mode is lazy (on Live Screen open)
    if (isMirror) initPeerJS();

    const autoPauseToggle = document.getElementById('autoPauseToggle');
    if (autoPauseToggle) {
        autoPauseToggle.addEventListener('change', (e) => { autoPauseEnabled = e.target.checked; });
    }

    if (isMirror) {
        document.body.classList.add('mirror-mode');
    } else {
        lastTimeMs = performance.now();
        rafId = requestAnimationFrame(loop);

        setInterval(() => {
            advanceTime();
            if (mirrorClients.length > 0) {
                mirrorClients.forEach(c => c.send({ type: 'sync', isPlaying, currentElapsedSeconds }));
            }
        }, 100);
    }

    document.addEventListener('keydown', handleKeydown);
}

// =============================================================
// KEYBOARD SHORTCUTS
// =============================================================
function handleKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    switch (e.key) {
        case ' ':
            e.preventDefault();
            if (isPlaying) {
                isPlaying = false;
            } else if (blocks.length > 0) {
                isPlaying = true; lastTimeMs = performance.now();
            }
            break;
        case 'ArrowRight': e.preventDefault(); jumpToNextBlock(); break;
        case 'ArrowLeft':  e.preventDefault(); jumpToPrevBlock(); break;
        case 'r': case 'R': e.preventDefault();
            if (!isPlaying && currentElapsedSeconds === 0) { doReset(); break; }
            if (confirm('Remettre la lecture au début ?')) doReset();
            break;
        case 'z': if (e.ctrlKey || e.metaKey) { e.preventDefault(); undo(); } break;
        case 'y': if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo(); } break;
    }
}

// =============================================================
// MENU DROPDOWN
// =============================================================
function initMenuDropdown() {
    const dropdown = document.getElementById('menuDropdown');
    const toggle   = document.getElementById('btnMenu');
    const panel    = document.getElementById('menuPanel');
    if (!dropdown || !toggle || !panel) return;

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !panel.classList.contains('hidden');
        panel.classList.toggle('hidden', open);
        toggle.classList.toggle('open', !open);
    });

    document.addEventListener('click', () => {
        panel.classList.add('hidden');
        toggle.classList.remove('open');
    });
    panel.addEventListener('click', e => e.stopPropagation());

    // Menu items
    document.getElementById('btnNew')?.addEventListener('click', () => { newConductor(); });
    document.getElementById('btnExport')?.addEventListener('click',    () => { exportJSON(); closeMenu(); });
    document.getElementById('btnOpenShareModal')?.addEventListener('click', () => {
        document.getElementById('shareModal')?.classList.remove('hidden');
        closeMenu();
    });
    document.querySelector('.menu-file-label')?.addEventListener('click', () => closeMenu());
}

function closeMenu() {
    document.getElementById('menuPanel')?.classList.add('hidden');
    document.getElementById('btnMenu')?.classList.remove('open');
}

// =============================================================
// MODALS
// =============================================================
function initModals() {
    // Close on overlay click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });

    // Live Screen modal
    document.getElementById('btnLiveScreen')?.addEventListener('click', openLiveModal);
    document.getElementById('btnCloseLiveModal')?.addEventListener('click', () => document.getElementById('liveModal').classList.add('hidden'));

    document.getElementById('btnOpenLiveWindow')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (!peerInitialized) {
            pendingLiveWindow = true;
            initPeerJS();
            btn.textContent = '⏳ Connexion...';
            return;
        }
        const url = getLiveUrl();
        if (url) {
            window.open(url, '_blank');
            btn.textContent = '📺 Ouvrir dans une nouvelle fenêtre';
        } else {
            pendingLiveWindow = true;
            btn.textContent = '⏳ Connexion...';
        }
    });

    document.getElementById('btnStartLiveSession')?.addEventListener('click', () => {
        if (!peerInitialized) {
            pendingLiveLink = true;
            initPeerJS();
            showLiveStatus('⏳ Connexion P2P en cours…');
            return;
        }
        if (!myPeerId) { showLiveStatus('⏳ Connexion P2P en cours…'); return; }
        showLiveLink();
    });

    document.getElementById('btnCopyLiveLink')?.addEventListener('click', () => {
        const val = document.getElementById('liveLinkInput').value;
        navigator.clipboard.writeText(val).then(() => {
            const btn = document.getElementById('btnCopyLiveLink');
            btn.textContent = '✅ Copié !';
            setTimeout(() => { btn.textContent = '📋 Copier'; }, 2000);
        });
    });

    // Cloud Share modal
    document.getElementById('btnCloseShareModal')?.addEventListener('click', () => document.getElementById('shareModal').classList.add('hidden'));

    document.getElementById('btnGenerateCloudLink')?.addEventListener('click', async () => {
        const statusEl  = document.getElementById('cloudStatus');
        const wrapperEl = document.getElementById('cloudLinkWrapper');
        const noticeEl  = document.getElementById('cloudNotice');

        statusEl.className  = 'cloud-loading';
        statusEl.textContent = '⏳ Chiffrement et envoi en cours…';
        wrapperEl.classList.add('hidden');
        noticeEl.classList.add('hidden');

        try {
            const url = await generateCloudLink();
            document.getElementById('cloudLinkInput').value = url;
            wrapperEl.classList.remove('hidden');
            noticeEl.classList.remove('hidden');
            statusEl.textContent = '';
        } catch(err) {
            statusEl.className  = 'cloud-error';
            statusEl.textContent = '❌ ' + err.message;
        }
    });

    document.getElementById('btnCopyCloudLink')?.addEventListener('click', () => {
        const val = document.getElementById('cloudLinkInput').value;
        navigator.clipboard.writeText(val).then(() => {
            const btn = document.getElementById('btnCopyCloudLink');
            btn.textContent = '✅ Copié !';
            setTimeout(() => { btn.textContent = '📋 Copier'; }, 2000);
        });
    });

    // Types manager modal
    document.getElementById('btnTypesManager')?.addEventListener('click', () => {
        renderTypesManager();
        document.getElementById('typesModal')?.classList.remove('hidden');
    });
    document.getElementById('btnCloseTypesModal')?.addEventListener('click', () => document.getElementById('typesModal')?.classList.add('hidden'));
    document.getElementById('btnAddType')?.addEventListener('click', addNewType);

    // Emoji button for the new-type form
    document.getElementById('btnNewTypeIcon')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        openEmojiPicker(btn, (emoji) => {
            newTypeIconValue = emoji;
            btn.textContent  = emoji;
        });
    });

    initEmojiPicker();
}

function openLiveModal() {
    const liveModal = document.getElementById('liveModal');
    liveModal.classList.remove('hidden');
    // We no longer init PeerJS here. Wait for button click.
    
    // Si le lien est déjà disponible, l'afficher directement
    if (myPeerId) {
        showLiveLink();
    } else {
        document.getElementById('liveLinkWrapper')?.classList.add('hidden');
        const qr = document.getElementById('liveQrCode');
        if (qr) { qr.classList.add('hidden'); qr.innerHTML = ''; }
    }
}

function showLiveLink() {
    const url = getLiveUrl();
    if (!url) return;
    const wrapper = document.getElementById('liveLinkWrapper');
    const qr      = document.getElementById('liveQrCode');
    document.getElementById('liveLinkInput').value = url;
    wrapper.classList.remove('hidden');
    // Générer le QR seulement si pas encore fait
    if (qr && !qr.querySelector('canvas, img')) {
        qr.innerHTML = '';
        new QRCode(qr, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        qr.classList.remove('hidden');
    } else if (qr) {
        qr.classList.remove('hidden');
    }
}

function showLiveStatus(msg) {
    const wrapper = document.getElementById('liveLinkWrapper');
    document.getElementById('liveLinkInput').value = msg;
    wrapper.classList.remove('hidden');
    setTimeout(() => wrapper.classList.add('hidden'), 3000);
}

function getLiveUrl() {
    if (!myPeerId) return null;
    return window.location.origin + window.location.pathname + '?mirror=' + myPeerId;
}

// =============================================================
// NEW CONDUCTOR
// =============================================================
function newConductor() {
    if (blocks.length > 0 && !confirm('Créer un nouveau conducteur ? Les modifications non sauvegardées seront perdues.')) return;
    blocks = [];
    showName = 'Nouveau Conducteur';
    currentBlockIndex = -1;
    currentElapsedSeconds = 0;
    isPlaying = false;
    undoStack = []; redoStack = [];
    recalculateTimes();
    renderTimeline(); renderListView(); updateStatusPanel(); updateTimelineVisuals();
    broadcastBlocks();
    closeMenu();
}

// =============================================================
// BLOCK TYPES MANAGER
// =============================================================
// =============================================================
// EMOJI PICKER
// =============================================================
function initEmojiPicker() {
    const overlay = document.getElementById('emojiPickerOverlay');
    const picker  = overlay?.querySelector('emoji-picker');
    if (!picker) return;

    picker.addEventListener('emoji-click', (e) => {
        const emoji = e.detail.unicode;
        if (emojiPickerCallback) emojiPickerCallback(emoji);
        overlay.classList.add('hidden');
        emojiPickerCallback = null;
    });

    document.addEventListener('click', (e) => {
        if (!overlay.classList.contains('hidden')
            && !overlay.contains(e.target)
            && !e.target.classList.contains('type-icon-btn')) {
            overlay.classList.add('hidden');
            emojiPickerCallback = null;
        }
    });
}

function openEmojiPicker(anchorEl, callback) {
    const overlay = document.getElementById('emojiPickerOverlay');
    if (!overlay) return;
    emojiPickerCallback = callback;
    const rect = anchorEl.getBoundingClientRect();
    // Position sous le bouton, en restant dans la fenêtre
    const overlayH = 400;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow >= overlayH) {
        overlay.style.top  = (rect.bottom + 6) + 'px';
    } else {
        overlay.style.top  = Math.max(6, rect.top - overlayH - 6) + 'px';
    }
    overlay.style.left = Math.min(rect.left, window.innerWidth - 360) + 'px';
    overlay.classList.remove('hidden');
}

function renderTypesManager() {
    const list = document.getElementById('typesList');
    if (!list) return;
    list.innerHTML = '';
    blockTypes.forEach((bt, i) => {
        const row = document.createElement('div');
        row.className = 'type-row';
        row.innerHTML = `
            <button class="type-icon-btn" title="Choisir un emoji">${bt.icon}</button>
            <input type="color" class="li-color" value="${bt.color}" title="Couleur">
            <input type="text" class="li-input type-name-input" value="${bt.name}" placeholder="Nom du type">
            <button class="action-btn del-btn type-del-btn" title="Supprimer">×</button>
        `;
        row.querySelector('.type-icon-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.currentTarget;
            openEmojiPicker(btn, (emoji) => {
                blockTypes[i].icon = emoji;
                btn.textContent = emoji;
                refreshAfterTypesChange();
            });
        });
        row.querySelector('.li-color').addEventListener('input', (e) => {
            blockTypes[i].color = e.target.value;
            refreshAfterTypesChange();
        });
        row.querySelector('.type-name-input').addEventListener('input', (e) => {
            blockTypes[i].name = e.target.value || 'Type';
            refreshAfterTypesChange();
        });
        row.querySelector('.type-del-btn').addEventListener('click', () => {
            if (blockTypes.length <= 1) { alert('Vous devez garder au moins un type.'); return; }
            blockTypes.splice(i, 1);
            renderTypesManager();
            refreshAfterTypesChange();
        });
        list.appendChild(row);
    });
}

function addNewType() {
    const nameInput  = document.getElementById('newTypeName');
    const colorInput = document.getElementById('newTypeColor');
    const name = (nameInput?.value || '').trim();
    if (!name) { nameInput?.focus(); return; }
    const color = colorInput?.value || '#6366f1';
    const icon  = newTypeIconValue || '📝';
    const id    = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'type_' + Date.now();
    blockTypes.push({ id, name, color, icon });
    if (nameInput) nameInput.value = '';
    newTypeIconValue = '📝';
    const btnNew = document.getElementById('btnNewTypeIcon');
    if (btnNew) btnNew.textContent = '📝';
    renderTypesManager();
    refreshAfterTypesChange();
}

function refreshAfterTypesChange() {
    renderTimeline(); renderListView(); updateStatusPanel(); broadcastBlocks();
}

// =============================================================
// LOCAL STORAGE SAVE / LOAD
// =============================================================
function saveToLocalStorage() {
    if (blocks.length === 0) { alert('Aucun conducteur à sauvegarder.'); return; }
    const data = { showName, blocks, blockTypes };
    localStorage.setItem('radiocuep_save', JSON.stringify(data));
    const btn = document.getElementById('btnSaveLocal');
    if (btn) { btn.textContent = '✅ Sauvegardé !'; setTimeout(() => { btn.textContent = '💾 Sauvegarde rapide'; }, 2000); }
}

function loadFromLocalStorage() {
    const raw = localStorage.getItem('radiocuep_save');
    if (!raw) return false;
    try {
        const data = JSON.parse(raw);
        showName  = data.showName || '';
        if (data.blockTypes && Array.isArray(data.blockTypes) && data.blockTypes.length > 0) {
            blockTypes = migrateBlockTypes(data.blockTypes);
        }
        blocks = (data.blocks || []).map(b => {
            const typeId = (b.type || '').toLowerCase();
            const bt = getBlockType(typeId);
            return {
                ...b,
                type:  bt.id,
                color: b.color && !b.color.startsWith('var') ? b.color : bt.color
            };
        });
        recalculateTimes();
        renderTimeline(); renderListView(); updateStatusPanel(); updateTimelineVisuals();
        return true;
    } catch(e) {
        return false;
    }
}

// =============================================================
// CLOUD SAVE (AES-256-GCM, key in URL fragment)
// =============================================================
async function generateCloudLink() {
    if (blocks.length === 0) throw new Error('Aucun conducteur à sauvegarder.');

    const payload = {
        showName, blockTypes,
        items: blocks.map(b => ({ id: b.id, type: b.type, title: b.title, desc: b.desc || '', dur: b.duration, color: b.color }))
    };

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv  = crypto.getRandomValues(new Uint8Array(12));

    const encoded   = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const rawKey    = await crypto.subtle.exportKey('raw', key);

    const encB64 = u8ToB64(new Uint8Array(encrypted));
    const ivB64  = u8ToB64(iv);
    const keyB64 = u8ToB64(new Uint8Array(rawKey));

    const resp = await fetch('save_share.php', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ data: encB64, iv: ivB64 })
    });
    if (!resp.ok) throw new Error('Erreur serveur (' + resp.status + ')');

    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Erreur serveur');

    const baseUrl = window.location.origin + window.location.pathname;
    return `${baseUrl}?share=${result.id}#k=${encodeURIComponent(keyB64)}`;
}

async function loadSharedContent(id, keyB64) {
    const resp = await fetch('save_share.php?id=' + encodeURIComponent(id));
    if (!resp.ok) throw new Error('Partage introuvable');
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Erreur serveur');

    const keyBytes  = b64ToU8(keyB64);
    const iv        = b64ToU8(result.iv);
    const encrypted = b64ToU8(result.data);

    const key       = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);

    parseJSON(new TextDecoder().decode(decrypted));
}

function u8ToB64(u8) {
    return btoa(String.fromCharCode(...u8));
}

function b64ToU8(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// =============================================================
// UNDO / REDO
// =============================================================
function saveUndoState() {
    undoStack.push(JSON.parse(JSON.stringify(blocks)));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.parse(JSON.stringify(blocks)));
    blocks = undoStack.pop();
    refresh();
}

function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.parse(JSON.stringify(blocks)));
    blocks = redoStack.pop();
    refresh();
}

function refresh() {
    recalculateTimes(); renderTimeline(); renderListView();
    updateStatusPanel(); updateTimelineVisuals(); broadcastBlocks();
}

// =============================================================
// DATA
// =============================================================
function parseJSON(content) {
    try {
        const rawData = JSON.parse(content);
        let parsed = [];

        showName = rawData.showName || '';

        // Load custom types if present
        if (rawData.blockTypes && Array.isArray(rawData.blockTypes) && rawData.blockTypes.length > 0) {
            blockTypes = migrateBlockTypes(rawData.blockTypes);
        }

        if (Array.isArray(rawData)) {
            parsed = rawData;
        } else if (rawData.blocks && Array.isArray(rawData.blocks)) {
            parsed = rawData.blocks;
        } else if (rawData.items && Array.isArray(rawData.items)) {
            parsed = rawData.items;
        } else {
            alert("Format JSON non reconnu.");
            return;
        }

        blocks = parsed.map((item, idx) => {
            let rawDur = item.duration || item.dur;
            let dur = 60;
            if (typeof rawDur === 'number') {
                dur = rawDur;
            } else if (typeof rawDur === 'string' && rawDur.includes(':')) {
                const parts = rawDur.split(':');
                dur = parseInt(parts[0]) * 60 + parseInt(parts[1]);
            } else if (!isNaN(parseInt(rawDur))) {
                dur = parseInt(rawDur);
            }

            // Resolve type: exact id match first, then fuzzy mapping
            const traw = (item.type || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
            let typeId = 'other';
            if (blockTypes.find(t => t.id === traw)) {
                typeId = traw;
            } else if (traw.includes('mus'))                                    typeId = 'music';
            else if (traw.includes('int') || traw.includes('autre'))            typeId = 'interview';
            else if (traw.includes('jing'))                                     typeId = 'jingle';
            else if (traw.includes('spok') || traw.includes('parol') ||
                     traw.includes('speak') || traw.includes('sequence') ||
                     traw.includes('s_quence'))                                  typeId = 'spoken';
            else if (traw.includes('ad') || traw.includes('pub'))               typeId = 'ads';

            const bt = getBlockType(typeId);
            return {
                id:       item.id || `b_${Date.now()}_${idx}`,
                title:    item.title || item.name || `Bloc ${idx + 1}`,
                desc:     item.desc || item.description || '',
                type:     bt.id,
                color:    item.color && !item.color.startsWith('var') ? item.color : bt.color,
                duration: dur > 0 ? dur : 10
            };
        });

        recalculateTimes();
        renderTimeline();
        renderListView();
        currentElapsedSeconds = 0;
        currentBlockIndex = -1;
        undoStack = []; redoStack = [];
        updateStatusPanel();
        updateTimelineVisuals();
        broadcastBlocks();
    } catch (e) {
        alert("Erreur de lecture du JSON: " + e.message);
    }
}

function recalculateTimes() {
    let t = 0;
    blocks.forEach(b => { b.startTime = t; b.endTime = t + b.duration; t += b.duration; });
}

// =============================================================
// ZOOM
// =============================================================
function getPPS() { return PIXELS_PER_SECOND * zoomFactor; }

function setZoom(factor) {
    zoomFactor = Math.min(4, Math.max(0.25, factor));
    if (zoomLabel) zoomLabel.textContent = Math.round(zoomFactor * 100) + '%';
    renderTimeline(); updateTimelineVisuals();
}

// =============================================================
// RENDERING
// =============================================================
function renderTimeline() {
    timelineTrack.innerHTML = '';
    const pps = getPPS();
    blocks.forEach((b, i) => {
        const bt  = getBlockType(b.type);
        const div = document.createElement('div');
        div.className = 'timeline-block';
        div.style.width      = `${b.duration * pps}px`;
        div.style.background = b.color || bt.color;

        div.innerHTML = `
            <div class="tb-number">${i + 1}</div>
            <div class="tb-content">
                <div class="tb-title">${b.title}</div>
                ${b.desc ? `<div class="tb-desc">${b.desc}</div>` : ''}
            </div>
            <div class="tb-duration">${formatTime(b.duration)}</div>
        `;
        if (b.desc) div.title = b.desc;
        timelineTrack.appendChild(div);
    });
    const endSpace = document.createElement('div');
    endSpace.style.cssText = 'width:50vw; height:100%; flex-shrink:0;';
    timelineTrack.appendChild(endSpace);
}

function renderListView() {
    listView.innerHTML = '';
    editorStats.textContent = `${blocks.length} bloc${blocks.length > 1 ? 's' : ''}`;

    blocks.forEach((b, i) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.setAttribute('draggable', 'true');
        item.dataset.index = i;

        if (i === currentBlockIndex) item.classList.add('active-block');

        item.innerHTML = `
            <div class="drag-handle" title="Déplacer">☰</div>
            <div class="li-index">${i + 1}</div>
            <input type="color" class="li-color binding-color" value="${b.color || '#52525b'}" title="Couleur">
            <div class="li-main">
                <div class="li-row1">
                    <select class="li-select binding-type">
                        ${blockTypes.map(t => `<option value="${t.id}"${t.id === b.type ? ' selected' : ''}>${t.icon} ${t.name}</option>`).join('')}
                    </select>
                    <input type="text" class="li-input binding-title" value="${b.title}" placeholder="Titre">
                    <input type="text" class="li-input li-dur binding-dur" value="${formatTime(b.duration)}" title="Durée MM:SS">
                </div>
                <div class="li-row2">
                    <input type="text" class="li-input li-desc binding-desc" value="${b.desc || ''}" placeholder="Notes / description…">
                </div>
            </div>
            <button class="action-btn dup-btn" title="Dupliquer">⧉</button>
            <button class="action-btn del-btn" title="Supprimer">×</button>
        `;

        item.querySelector('.binding-type').addEventListener('change', (e) => {
            saveUndoState();
            b.type  = e.target.value;
            b.color = getBlockType(b.type).color;
            item.querySelector('.binding-color').value = b.color;
            renderTimeline(); updateStatusPanel(); broadcastBlocks();
        });

        item.querySelector('.binding-title').addEventListener('input', (e) => {
            b.title = e.target.value; renderTimeline(); updateStatusPanel(); broadcastBlocks();
        });
        item.querySelector('.binding-title').addEventListener('blur', () => saveUndoState());

        item.querySelector('.binding-color').addEventListener('input', (e) => {
            b.color = e.target.value; renderTimeline(); updateStatusPanel(); broadcastBlocks();
        });

        item.querySelector('.binding-desc').addEventListener('input', (e) => {
            b.desc = e.target.value; renderTimeline(); broadcastBlocks();
        });

        item.querySelector('.binding-dur').addEventListener('change', (e) => {
            saveUndoState();
            const raw = e.target.value;
            let dur = raw.includes(':') ? parseInt(raw.split(':')[0]) * 60 + parseInt(raw.split(':')[1]) : parseInt(raw);
            if (!isNaN(dur) && dur > 0) {
                b.duration = dur; recalculateTimes();
                renderTimeline(); renderListView(); updateStatusPanel(); updateTimelineVisuals(); broadcastBlocks();
            } else { e.target.value = formatTime(b.duration); }
        });

        item.querySelector('.dup-btn').addEventListener('click', () => {
            saveUndoState();
            blocks.splice(i + 1, 0, { ...b, id: 'blk_' + Date.now() });
            recalculateTimes(); renderTimeline(); renderListView(); updateStatusPanel(); updateTimelineVisuals(); broadcastBlocks();
        });

        item.querySelector('.del-btn').addEventListener('click', () => {
            saveUndoState();
            blocks.splice(i, 1);
            recalculateTimes(); renderTimeline(); renderListView(); updateStatusPanel(); updateTimelineVisuals(); broadcastBlocks();
        });

        // Drag & Drop
        item.addEventListener('dragstart', (e) => { draggedIndex = i; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
        item.addEventListener('dragend', () => { item.classList.remove('dragging'); document.querySelectorAll('.list-item').forEach(el => el.classList.remove('drag-over')); draggedIndex = null; });
        item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', (e) => {
            e.preventDefault(); item.classList.remove('drag-over');
            if (draggedIndex === null || draggedIndex === i) return;
            saveUndoState();
            blocks.splice(i, 0, blocks.splice(draggedIndex, 1)[0]);
            recalculateTimes(); renderTimeline(); renderListView(); updateStatusPanel(); updateTimelineVisuals(); broadcastBlocks();
        });

        listView.appendChild(item);
    });
}

function drawGraduations() {
    timelineGrads.innerHTML = '';
    const containerW = timelineContainer.clientWidth;
    const pps = getPPS();
    const tickIntervalSec = 30;
    const playheadPx  = containerW * PLAYHEAD_PERCENT;
    const numTicks    = Math.ceil(containerW / (tickIntervalSec * pps)) + 1;
    const baseSec     = Math.floor(currentElapsedSeconds / tickIntervalSec) * tickIntervalSec;

    for (let i = -2; i < numTicks + 2; i++) {
        const tickSec = baseSec + i * tickIntervalSec;
        if (tickSec < 0) continue;
        const tickX = playheadPx + (tickSec - currentElapsedSeconds) * pps;
        if (tickX < 0 || tickX > containerW) continue;

        const tick = document.createElement('div');
        tick.className  = 'timeline-tick';
        tick.style.left = `${tickX}px`;

        const label = formatTime(tickSec);

        const lbl = document.createElement('div');
        lbl.className   = 'timeline-tick-label';
        lbl.textContent = label;
        tick.appendChild(lbl);
        timelineGrads.appendChild(tick);
    }
}

// =============================================================
// PLAYBACK
// =============================================================
function jumpToNextBlock() {
    if (!blocks.length) return;
    const idx = getCurrentBlockIndex();
    if (idx < blocks.length - 1) {
        currentElapsedSeconds = blocks[idx + 1].startTime;
        updateStatusPanel(); updateTimelineVisuals();
    }
}

function jumpToPrevBlock() {
    if (!blocks.length) return;
    const idx = getCurrentBlockIndex();
    currentElapsedSeconds = idx > 0 ? blocks[idx - 1].startTime : 0;
    updateStatusPanel(); updateTimelineVisuals();
}

function getCurrentBlockIndex() {
    if (!blocks.length) return -1;
    if (currentElapsedSeconds < 0) return 0;
    for (let i = 0; i < blocks.length; i++) {
        if (currentElapsedSeconds >= blocks[i].startTime && currentElapsedSeconds < blocks[i].endTime) return i;
    }
    if (currentElapsedSeconds >= blocks[blocks.length - 1].endTime) return blocks.length - 1;
    return -1;
}

function updateProgressBar() {
    if (!progressBar || !blocks.length) return;
    progressBar.style.width = `${Math.min(100, (currentElapsedSeconds / blocks[blocks.length - 1].endTime) * 100)}%`;
}

function updateStatusPanel() {
    if (!blocks.length) {
        curName.textContent = "Aucun conducteur chargé";
        curType.textContent = "EN ATTENTE";
        xxlCountdown.textContent = "00:00";
        curIcon.textContent      = "💿";
        curIcon.style.background = 'var(--bg-element)';
        totalRemaining.textContent = "00:00";
        if (nextBlockEl)  nextBlockEl.textContent  = '';
        return;
    }

    const idx           = getCurrentBlockIndex();
    const totalDuration = blocks[blocks.length - 1].endTime;

    if (currentElapsedSeconds >= totalDuration) {
        curName.textContent        = "CONDUCTEUR TERMINÉ";
        curType.textContent        = "FIN";
        xxlCountdown.textContent   = "00:00";
        curIcon.textContent        = "🏁";
        totalRemaining.textContent = "00:00";
        xxlCountdown.classList.remove('warn', 'danger');
        if (nextBlockEl) nextBlockEl.textContent = '';
        isPlaying = false;
        updateProgressBar();
        return;
    }

    const b  = blocks[idx];
    const bt = getBlockType(b.type);

    if (currentBlockIndex !== idx) {
        const prevBlockIndex = currentBlockIndex;
        currentBlockIndex = idx;

        curName.textContent      = b.title;
        curType.textContent      = bt.name.toUpperCase();
        curIcon.textContent      = bt.icon;
        curIcon.style.background = bt.color;

        // Highlight active block in list
        document.querySelectorAll('#listView .list-item').forEach((el, i) => {
            el.classList.toggle('active-block', i === idx);
        });

        // Scroll active block into view
        const activeEl = listView.querySelector('.list-item.active-block');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        // Next block display
        if (nextBlockEl) {
            if (idx < blocks.length - 1) {
                const nb  = blocks[idx + 1];
                const nbt = getBlockType(nb.type);
                nextBlockEl.innerHTML = `SUIVANT&nbsp;: ${nbt.icon} <strong>${nb.title}</strong>&nbsp;<span>(${formatTime(nb.duration)})</span>`;
            } else {
                nextBlockEl.textContent = 'DERNIER BLOC';
            }
        }

        // Auto-pause at start of each new block (not on initial play from reset)
        if (autoPauseEnabled && isPlaying && prevBlockIndex !== -1) {
            isPlaying = false;
            currentElapsedSeconds = b.startTime;
        }
    }

    const remaining = b.endTime - currentElapsedSeconds;
    xxlCountdown.textContent = formatCountdown(remaining);
    xxlCountdown.classList.toggle('danger', remaining <= 3 && remaining > 0);
    xxlCountdown.classList.toggle('warn',   remaining > 3 && remaining <= 5);

    totalRemaining.textContent = formatCountdown(Math.max(0, totalDuration - currentElapsedSeconds));
    updateProgressBar();
}

function updateTimelineVisuals() {
    const containerW  = timelineContainer.clientWidth;
    const playheadPx  = containerW * PLAYHEAD_PERCENT;
    const pps         = getPPS();
    timelineTrack.style.transform = `translateX(${playheadPx - currentElapsedSeconds * pps}px)`;
    drawGraduations();
    const blockEls = timelineTrack.querySelectorAll('.timeline-block');
    const idx = getCurrentBlockIndex();
    blockEls.forEach((el, i) => {
        el.classList.toggle('active', i === idx);
        const content = el.querySelector('.tb-content');
        if (!content) return;
        if (i === idx) {
            const consumed = (currentElapsedSeconds - blocks[i].startTime) * pps;
            content.style.transform = `translateX(${Math.max(0, consumed - 26)}px)`;
        } else {
            content.style.transform = '';
        }
    });
}

function loop(timestamp) {
    if (isMirror) {
        // Dead-reckoning: interpolate smoothly from last sync instead of snapping each frame
        if (isPlaying && mirrorReceivedAt > 0) {
            currentElapsedSeconds = mirrorMasterElapsed + (performance.now() - mirrorReceivedAt) / 1000;
        } else {
            currentElapsedSeconds = mirrorMasterElapsed;
        }
        updateStatusPanel();
        updateTimelineVisuals();
        rafId = requestAnimationFrame(loop);
        return;
    }
    advanceTime();
    updateTimelineVisuals();
    rafId = requestAnimationFrame(loop);
}

// =============================================================
// EXPORT JSON
// =============================================================
function exportJSON() {
    const data = {
        meta:       { version: "1.3", generated: new Date().toISOString() },
        showName:   showName || 'Conducteur',
        blockTypes: blockTypes,
        items:      blocks.map(b => ({ id: b.id, type: b.type, title: b.title, desc: b.desc || '', dur: b.duration, color: b.color }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${(showName || 'conducteur').replace(/\s+/g, '_')}.json`;
    a.click(); URL.revokeObjectURL(url);
}

// =============================================================
// UTILS
// =============================================================
function formatTime(secTotal) {
    const s = Math.floor(secTotal);
    return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

function formatCountdown(secTotal) {
    const s    = Math.ceil(secTotal);
    const sign = s < 0 ? '-' : '';
    const as   = Math.abs(s);
    const m    = Math.floor(as / 60);
    const ss   = as % 60;
    if (m >= 60) {
        const h = Math.floor(m / 60);
        return `${sign}${String(h).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    }
    return `${sign}${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

function doReset() {
    isPlaying = false; currentElapsedSeconds = 0;
    lastTimeMs = performance.now();
    currentBlockIndex = -1;
    document.querySelectorAll('#listView .list-item').forEach(el => el.classList.remove('active-block'));
    updateStatusPanel(); updateTimelineVisuals();
}

// =============================================================
// EVENTS
// =============================================================
jsonFileIn.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => parseJSON(evt.target.result);
    reader.readAsText(file); e.target.value = '';
});

btnPlay.addEventListener('click', () => {
    if (!blocks.length) return;
    isPlaying = true; lastTimeMs = performance.now();
    if (!rafId) rafId = requestAnimationFrame(loop);
});

btnPause.addEventListener('click', () => { isPlaying = false; });
btnReset.addEventListener('click', () => {
    if (!isPlaying && currentElapsedSeconds === 0) { doReset(); return; }
    if (confirm('Remettre la lecture au début ?')) doReset();
});
btnNext.addEventListener('click', jumpToNextBlock);
if (btnUndo) btnUndo.addEventListener('click', undo);
if (btnRedo) btnRedo.addEventListener('click', redo);
if (zoomInBtn)  zoomInBtn.addEventListener('click',  () => setZoom(zoomFactor * 1.5));
if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setZoom(zoomFactor / 1.5));

btnAddBlock.addEventListener('click', () => {
    saveUndoState();
    const dt = blockTypes[0] || { id: 'other', color: '#52525b' };
    blocks.push({ id: `blk_${Date.now()}`, title: 'Nouveau Bloc', desc: '', type: dt.id, color: dt.color, duration: 60 });
    recalculateTimes(); renderTimeline(); renderListView(); updateStatusPanel(); updateTimelineVisuals();
    setTimeout(() => { listView.scrollTop = listView.scrollHeight; }, 50);
});

// =============================================================
// PEERJS
// =============================================================
function generatePeerId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function initPeerJS() {
    if (peerInitialized) return;
    peerInitialized = true;
    peerStatus.className = 'peer-status connecting';
    peer = new Peer(generatePeerId());

    peer.on('open', (id) => {
        myPeerId = id;
        peerStatus.className = 'peer-status connected';

        if (pendingLiveWindow) {
            pendingLiveWindow = false;
            const url = getLiveUrl();
            if (url) window.open(url, '_blank');
        }

        if (pendingLiveLink) {
            pendingLiveLink = false;
            showLiveLink();
        }

        if (isMirror) {
            const conn = peer.connect(mirrorTarget);
            conn.on('open',  () => { mirrorConn = conn; setupMirrorReceiver(conn); });
            conn.on('close', () => { peerStatus.className = 'peer-status error'; });
            conn.on('error', () => { peerStatus.className = 'peer-status error'; });
        }
    });

    if (!isMirror) {
        peer.on('connection', (conn) => {
            mirrorClients.push(conn);
            conn.on('open',  () => conn.send({ type: 'blocks', blocks, showName }));
            conn.on('close', () => { const i = mirrorClients.indexOf(conn); if (i > -1) mirrorClients.splice(i, 1); });
        });
    }

    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            // ID collision — silently retry with a new one
            peer.destroy();
            peerInitialized = false;
            initPeerJS();
            return;
        }
        console.error(err);
        peerStatus.className = 'peer-status error';
        peerStatus.title = "Erreur P2P: " + err.type;
    });
}

function setupMirrorReceiver(conn) {
    conn.on('data', (data) => {
        if (data.type === 'blocks') {
            blocks = data.blocks;
            showName = data.showName || '';
            recalculateTimes(); renderTimeline();
            currentBlockIndex = -1; updateStatusPanel();
        } else if (data.type === 'sync') {
            isPlaying            = data.isPlaying;
            mirrorMasterElapsed  = data.currentElapsedSeconds;
            mirrorReceivedAt     = performance.now();
            // Start the RAF loop if not already running
            if (!rafId) rafId = requestAnimationFrame(loop);
        }
    });
}

function broadcastBlocks() {
    if (isMirror) return;
    mirrorClients.forEach(c => c.send({ type: 'blocks', blocks, showName }));
    scheduleAutoSave();
}

// =============================================================
// BOOT
// =============================================================
init();

window.addEventListener('DOMContentLoaded', async () => {
    if (!isMirror) {
        const params   = new URLSearchParams(window.location.search);
        const shareId  = params.get('share');
        const keyMatch = window.location.hash.match(/#k=(.+)/);

        if (shareId && keyMatch) {
            try {
                await loadSharedContent(shareId, decodeURIComponent(keyMatch[1]));
                return;
            } catch(err) {
                alert('Impossible de charger le partage : ' + err.message);
            }
        }

        // Auto-load last session from localStorage (blank on first visit)
        loadFromLocalStorage();
    }
});
