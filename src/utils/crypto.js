/**
 * Crypto utilities for secure configuration encryption
 * 
 * Uses AES-256-GCM for authenticated encryption of user config (API keys, etc.)
 * Config is encrypted before embedding in manifest URL, decrypted on each request.
 */

const crypto = require('crypto');
const { log } = require('../utils');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Get encryption key from environment or derive from passphrase
 * @returns {Buffer} 32-byte encryption key
 */
function getEncryptionKey() {
    const envKey = process.env.SUBSENSE_ENCRYPTION_KEY;
    
    if (!envKey) {
        throw new Error('SUBSENSE_ENCRYPTION_KEY environment variable is required for encryption');
    }
    
    if (/^[a-fA-F0-9]{64}$/.test(envKey)) {
        return Buffer.from(envKey, 'hex');
    }
    
    const salt = 'subsense-config-v1';
    return crypto.pbkdf2Sync(envKey, salt, 100000, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt configuration object for embedding in manifest URL
 * @param {Object} config - Configuration object (e.g., { subsource: { apiKey: '...' } })
 * @returns {string} URL-safe base64 encoded encrypted data
 */
function encryptConfig(config) {
    try {
        const key = getEncryptionKey();
        const iv = crypto.randomBytes(IV_LENGTH);
        
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH
        });
        
        const plaintext = JSON.stringify(config);
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final()
        ]);
        
        const authTag = cipher.getAuthTag();
        const combined = Buffer.concat([iv, authTag, encrypted]);
        
        return combined.toString('base64url');
    } catch (error) {
        log('error', `[Crypto] Encryption failed: ${error.message}`);
        throw new Error('Failed to encrypt configuration');
    }
}

/**
 * Decrypt configuration from manifest URL
 * @param {string} encryptedData - URL-safe base64 encoded encrypted data
 * @returns {Object} Decrypted configuration object
 */
function decryptConfig(encryptedData) {
    try {
        const key = getEncryptionKey();
        
        const combined = Buffer.from(encryptedData, 'base64url');
        
        if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
            throw new Error('Invalid encrypted data: too short');
        }
        
        const iv = combined.subarray(0, IV_LENGTH);
        const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
        
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH
        });
        
        decipher.setAuthTag(authTag);
        
        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);
        
        return JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
        const wrapped = new Error(`Failed to decrypt configuration - invalid or corrupted data (${error.message})`);
        wrapped.cause = error;
        throw wrapped;
    }
}

/**
 * Generate a new random encryption key (for setup purposes)
 * @returns {string} 64-character hex key
 */
function generateEncryptionKey() {
    return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Test if encryption key is properly configured
 * @returns {boolean} True if encryption is available
 */
function isEncryptionConfigured() {
    try {
        getEncryptionKey();
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    encryptConfig,
    decryptConfig,
    generateEncryptionKey,
    isEncryptionConfigured
};
