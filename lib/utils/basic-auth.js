const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

module.exports = (auth) => {
  if (!auth || !auth.username ||
    typeof auth.username !== 'string' ||
    (auth.password && typeof auth.password !== 'string')) return {};
  const creds = `${auth.username}:${auth.password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
};
