<?php
/**
 * RadioCueP - Cloud Save & Share API
 *
 * POST  {"data": "<base64>", "iv": "<base64>"}  → {"ok": true, "id": "abc123def456"}
 * GET   ?id=abc123def456                         → {"ok": true, "data": "...", "iv": "..."}
 *
 * The encryption key NEVER reaches this server.
 * It lives exclusively in the URL fragment (#k=...) on the client side.
 */

define('DATA_DIR', __DIR__ . '/shares/');
define('MAX_TTL',  100 * 86400); // 100 days

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Create data directory if needed
if (!is_dir(DATA_DIR)) {
    if (!mkdir(DATA_DIR, 0750, true)) {
        echo json_encode(['ok' => false, 'error' => 'Impossible de créer le répertoire de données.']);
        exit;
    }
}

// Protect data dir from direct listing
if (!file_exists(DATA_DIR . '.htaccess')) {
    file_put_contents(DATA_DIR . '.htaccess', "Deny from all\n");
}

// --- Cleanup expired files (opportunistic, ~5% of requests) ---
if (rand(1, 20) === 1) {
    foreach (glob(DATA_DIR . '*.json') as $f) {
        $p = json_decode(file_get_contents($f), true);
        if (!$p || $p['expires'] < time()) @unlink($f);
    }
}

// =============================================================
// POST — save encrypted blob
// =============================================================
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);

    if (empty($body['data']) || empty($body['iv'])) {
        echo json_encode(['ok' => false, 'error' => 'Données manquantes (data, iv)']);
        exit;
    }

    // Validate base64
    if (!preg_match('/^[A-Za-z0-9+\/=]+$/', $body['data']) ||
        !preg_match('/^[A-Za-z0-9+\/=]+$/', $body['iv'])) {
        echo json_encode(['ok' => false, 'error' => 'Format de données invalide']);
        exit;
    }

    // Max blob size: 1 MB
    if (strlen($body['data']) > 1_048_576) {
        echo json_encode(['ok' => false, 'error' => 'Conducteur trop volumineux (max 1 Mo)']);
        exit;
    }

    $id      = bin2hex(random_bytes(8)); // 16-char hex ID
    $payload = [
        'data'    => $body['data'],
        'iv'      => $body['iv'],
        'created' => time(),
        'expires' => time() + MAX_TTL,
    ];

    if (file_put_contents(DATA_DIR . $id . '.json', json_encode($payload)) === false) {
        echo json_encode(['ok' => false, 'error' => 'Erreur d\'écriture sur le serveur']);
        exit;
    }

    echo json_encode(['ok' => true, 'id' => $id]);
    exit;
}

// =============================================================
// GET — retrieve encrypted blob
// =============================================================
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $id = preg_replace('/[^a-f0-9]/', '', $_GET['id'] ?? '');

    if (strlen($id) !== 16) {
        echo json_encode(['ok' => false, 'error' => 'ID invalide']);
        exit;
    }

    $file = DATA_DIR . $id . '.json';

    if (!file_exists($file)) {
        echo json_encode(['ok' => false, 'error' => 'Partage introuvable ou expiré']);
        exit;
    }

    $payload = json_decode(file_get_contents($file), true);

    if (!$payload || $payload['expires'] < time()) {
        @unlink($file);
        echo json_encode(['ok' => false, 'error' => 'Lien expiré (valide 100 jours)']);
        exit;
    }

    echo json_encode(['ok' => true, 'data' => $payload['data'], 'iv' => $payload['iv']]);
    exit;
}

echo json_encode(['ok' => false, 'error' => 'Méthode non supportée']);
