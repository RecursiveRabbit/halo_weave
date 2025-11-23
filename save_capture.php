<?php
// Simple PHP script to save large JSON files from browser
// Usage: POST JSON data to this endpoint

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $json = file_get_contents('php://input');
    $filename = 'attention_capture_' . time() . '.json';

    if (file_put_contents($filename, $json)) {
        echo json_encode([
            'success' => true,
            'filename' => $filename,
            'size' => strlen($json)
        ]);
    } else {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Failed to write file']);
    }
} else {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method not allowed']);
}
?>
