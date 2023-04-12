const crypto = require('crypto');
const {LEGACY_CRYPTO, ENCRYPTION_SECRET, JWT_SECRET} = require('../config');
const algorithm = LEGACY_CRYPTO ? 'aes-256-ctr' : 'aes-256-cbc';
const iv = crypto.randomBytes(16);
const secretKey = crypto.createHash('sha256')
  .update(ENCRYPTION_SECRET || JWT_SECRET)
  .digest('base64')
  .substring(0, 32);

const encrypt = (text) => {
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  const data = {
    iv: iv.toString('hex'),
    content: encrypted.toString('hex')
  };
  return JSON.stringify(data);
};

const decrypt = (data) => {
  let hash;
  try {
    hash = JSON.parse(data);
  } catch (err) {
    console.log(`failed to parse json string ${data}`);
    throw err;
  }
  const decipher = crypto.createDecipheriv(algorithm, secretKey, Buffer.from(hash.iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(hash.content, 'hex')), decipher.final()]);
  return decrypted.toString();
};

module.exports = {
  encrypt,
  decrypt
};
