'use strict';

const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const lowered = String(value).toLowerCase();
  return lowered === '1' || lowered === 'true' || lowered === 'yes';
}

function validateTurnEnv() {
  const required = ['TURN_USERNAME', 'TURN_PASSWORD', 'TURN_DOMAIN'];
  const missing = required.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');

  if (missing.length > 0) {
    throw new Error(`Missing required TURN environment variables: ${missing.join(', ')}`);
  }
}

function buildTurnUrls(domain) {
  const host = String(domain || '').trim();
  return [
    `turn:${host}:3478?transport=udp`,
    `turn:${host}:3478?transport=tcp`,
    `turns:${host}:5349?transport=tcp`,
  ];
}

function buildIceServers() {
  const disableTurn = parseBoolean(process.env.DISABLE_TURN, false);
  const servers = [{ urls: DEFAULT_STUN_SERVERS.slice() }];

  if (disableTurn) {
    return servers;
  }

  validateTurnEnv();

  const urls = process.env.TURN_URLS
    ? String(process.env.TURN_URLS)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : buildTurnUrls(process.env.TURN_DOMAIN);

  servers.push({
    urls,
    username: String(process.env.TURN_USERNAME),
    credential: String(process.env.TURN_PASSWORD),
  });

  return servers;
}

module.exports = {
  buildIceServers,
  validateTurnEnv,
};
