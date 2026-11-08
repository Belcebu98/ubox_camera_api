'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function patch(file, oldText, newText, label) {
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes(newText)) return console.log(`SKIP  ${label} (ya aplicado)`);
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`ANCLA ${label}: esperaba 1 coincidencia, hay ${count}`);
  fs.writeFileSync(file, source.replace(oldText, newText));
  console.log(`OK    ${label}`);
}

patch('helpers.js',
`var sha1 = require('js-sha1');
const axios = require('axios');
require('dotenv').config();`,
`var sha1 = require('js-sha1');
const axios = require('axios');
const { randomBytes } = require('node:crypto');
require('dotenv').config();

const SENSITIVE = /token|password|cookie|authorization|prefix|^loginId$|^loginPwd$/i;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, SENSITIVE.test(key) ? '[REDACTED]' : redact(item),
  ]));
}`,
'import crypto + redactor');

patch('helpers.js',
`function logDebug(message, data) {
  if (process.env.debugmode === 'true') {
    console.log('DEBUG', message, data);
  }
}`,
`function logDebug(message, data) {
  if (process.env.debugmode === 'true') {
    console.log('DEBUG', message, redact(data));
  }
}`,
'redact debug output');

patch('helpers.js',
`function generateRandomString(length) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}`,
`function generateRandomString(length) {
  return randomBytes(Math.ceil(length * 3 / 4))
    .toString('base64url')
    .slice(0, length);
}`,
'crypto-secure device token');

execFileSync(process.execPath, ['--check', 'helpers.js'], { stdio: 'inherit' });
console.log('helpers.js: sintaxis correcta');