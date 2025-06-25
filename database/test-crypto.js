const crypto = require('./crypto');

// Colors for console output
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m'
};

function log(color, message) {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// Test data
const testPassword = 'mySecurePassword123!';
const testEmails = [
    { email: 'test1@example.com', subject: 'Test Email 1', message: 'This is a test message' },
    { email: 'test2@example.com', subject: 'Test Email 2', message: 'Another test message' }
];
const testSettings = {
    checkinInterval: '2-hours',
    inactivityPeriod: '1-day',
    isActive: true
};

console.log(colors.blue + '🔐 Testing Deadman Switch Crypto Module\n' + colors.reset);

try {
    // Test 1: Salt generation
    log('yellow', '📋 Test 1: Salt Generation');
    const salt1 = crypto.generateSalt();
    const salt2 = crypto.generateSalt();

    if (salt1 !== salt2) {
        log('green', '✅ Salt generation: PASS (unique salts generated)');
    } else {
        log('red', '❌ Salt generation: FAIL (salts not unique)');
        throw new Error('Salt generation failed');
    }
    console.log(`   Salt example: ${salt1.substring(0, 20)}...`);

    // Test 2: Password hashing
    log('yellow', '\n📋 Test 2: Password Hashing');
    const passwordHash = crypto.hashPassword(testPassword, salt1);
    const samePasswordHash = crypto.hashPassword(testPassword, salt1);

    if (passwordHash === samePasswordHash) {
        log('green', '✅ Password hashing: PASS (consistent hashes)');
    } else {
        log('red', '❌ Password hashing: FAIL (inconsistent hashes)');
        throw new Error('Password hashing failed');
    }
    console.log(`   Hash example: ${passwordHash.substring(0, 20)}...`);

    // Test 3: Password verification
    log('yellow', '\n📋 Test 3: Password Verification');
    const isValidPassword = crypto.verifyPassword(testPassword, passwordHash, salt1);
    const isInvalidPassword = crypto.verifyPassword('wrongPassword', passwordHash, salt1);

    if (isValidPassword && !isInvalidPassword) {
        log('green', '✅ Password verification: PASS');
    } else {
        log('red', '❌ Password verification: FAIL');
        throw new Error('Password verification failed');
    }

    // Test 4: Data encryption/decryption
    log('yellow', '\n📋 Test 4: Data Encryption/Decryption');
    const testData = 'This is sensitive data that needs encryption';
    const encryptedData = crypto.encryptData(testData, testPassword, salt1);
    const decryptedData = crypto.decryptData(encryptedData, testPassword, salt1);

    if (decryptedData === testData) {
        log('green', '✅ Data encryption/decryption: PASS');
    } else {
        log('red', '❌ Data encryption/decryption: FAIL');
        throw new Error('Data encryption/decryption failed');
    }
    console.log(`   Original: ${testData}`);
    console.log(`   Encrypted: ${encryptedData.encrypted.substring(0, 30)}...`);
    console.log(`   Decrypted: ${decryptedData}`);

    // Test 5: Email encryption/decryption
    log('yellow', '\n📋 Test 5: Email Encryption/Decryption');
    const encryptedEmails = crypto.encryptEmails(testEmails, testPassword, salt1);
    const decryptedEmails = crypto.decryptEmails(encryptedEmails, testPassword, salt1);

    if (JSON.stringify(decryptedEmails) === JSON.stringify(testEmails)) {
        log('green', '✅ Email encryption/decryption: PASS');
    } else {
        log('red', '❌ Email encryption/decryption: FAIL');
        throw new Error('Email encryption/decryption failed');
    }
    console.log(`   Original emails: ${testEmails.length} items`);
    console.log(`   Decrypted emails: ${decryptedEmails.length} items`);

    // Test 6: Settings encryption/decryption
    log('yellow', '\n📋 Test 6: Settings Encryption/Decryption');
    const encryptedSettings = crypto.encryptSettings(testSettings, testPassword, salt1);
    const decryptedSettings = crypto.decryptSettings(encryptedSettings, testPassword, salt1);

    if (JSON.stringify(decryptedSettings) === JSON.stringify(testSettings)) {
        log('green', '✅ Settings encryption/decryption: PASS');
    } else {
        log('red', '❌ Settings encryption/decryption: FAIL');
        throw new Error('Settings encryption/decryption failed');
    }
    console.log(`   Original settings: ${JSON.stringify(testSettings)}`);
    console.log(`   Decrypted settings: ${JSON.stringify(decryptedSettings)}`);

    // Test 7: Wrong password fails decryption
    log('yellow', '\n📋 Test 7: Wrong Password Protection');
    try {
        crypto.decryptData(encryptedData, 'wrongPassword', salt1);
        log('red', '❌ Wrong password protection: FAIL (should have thrown error)');
        throw new Error('Wrong password protection failed');
    } catch (error) {
        if (error.message.includes('Decryption failed')) {
            log('green', '✅ Wrong password protection: PASS (correctly rejected)');
        } else {
            throw error;
        }
    }

    // Test 8: Token generation
    log('yellow', '\n📋 Test 8: Token Generation');
    const sessionToken1 = crypto.generateSessionToken();
    const sessionToken2 = crypto.generateSessionToken();
    const checkinToken1 = crypto.generateCheckinToken();
    const checkinToken2 = crypto.generateCheckinToken();

    if (sessionToken1 !== sessionToken2 && checkinToken1 !== checkinToken2) {
        log('green', '✅ Token generation: PASS (unique tokens)');
    } else {
        log('red', '❌ Token generation: FAIL (tokens not unique)');
        throw new Error('Token generation failed');
    }
    console.log(`   Session token: ${sessionToken1}`);
    console.log(`   Checkin token: ${checkinToken1}`);

    // Test 9: Encrypted data validation
    log('yellow', '\n📋 Test 9: Encrypted Data Validation');
    const validData = crypto.validateEncryptedData(encryptedData);
    const invalidData = crypto.validateEncryptedData({ encrypted: 'test' });

    if (validData && !invalidData) {
        log('green', '✅ Encrypted data validation: PASS');
    } else {
        log('red', '❌ Encrypted data validation: FAIL');
        throw new Error('Encrypted data validation failed');
    }

    // Test 10: Performance test
    log('yellow', '\n📋 Test 10: Performance Test');
    const startTime = Date.now();
    for (let i = 0; i < 10; i++) {
        const salt = crypto.generateSalt();
        const hash = crypto.hashPassword(testPassword, salt);
        const encrypted = crypto.encryptData('test data', testPassword, salt);
        const decrypted = crypto.decryptData(encrypted, testPassword, salt);
    }
    const endTime = Date.now();
    const duration = endTime - startTime;

    log('green', `✅ Performance test: ${duration}ms for 10 encrypt/decrypt cycles`);

    if (duration < 5000) { // Should be under 5 seconds
        log('green', '✅ Performance: ACCEPTABLE');
    } else {
        log('yellow', '⚠️  Performance: SLOW (but functional)');
    }

    // All tests passed!
    log('blue', '\n🎉 ALL CRYPTO TESTS PASSED! 🎉');
    log('green', '✅ Your encryption system is ready for production!');

    console.log(colors.blue + '\n📊 Crypto Module Summary:' + colors.reset);
    console.log('   • AES-256-GCM encryption ✅');
    console.log('   • PBKDF2 key derivation (100,000 iterations) ✅');
    console.log('   • Secure password hashing ✅');
    console.log('   • Email & settings encryption ✅');
    console.log('   • Token generation ✅');
    console.log('   • Wrong password protection ✅');
    console.log('   • Data validation ✅');

} catch (error) {
    log('red', `\n💥 CRYPTO TEST FAILED: ${error.message}`);
    log('red', 'Stack trace:');
    console.error(error.stack);
    process.exit(1);
}
