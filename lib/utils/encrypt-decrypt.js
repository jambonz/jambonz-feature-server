const crypto = require('crypto');
const algorithm = 'aes-256-cbc';
const iv = crypto.randomBytes(16);
const secretKey = crypto.createHash('sha256')
  .update(String(process.env.JWT_SECRET))
  .digest('base64')
  .substr(0, 32);

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
  const decrpyted = Buffer.concat([decipher.update(Buffer.from(hash.content, 'hex')), decipher.final()]);
  return decrpyted.toString();
};

module.exports = {
  encrypt,
  decrypt
};
