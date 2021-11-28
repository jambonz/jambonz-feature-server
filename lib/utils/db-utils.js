const {decrypt} = require('./encrypt-decrypt');

const sqlAccountDetails = `SELECT * 
FROM accounts account 
WHERE account.account_sid = ?`;
const sqlSpeechCredentials = `SELECT * 
FROM speech_credentials 
WHERE account_sid = ? `;
const sqlSpeechCredentialsForSP = `SELECT * 
FROM speech_credentials 
WHERE service_provider_sid =  
(SELECT service_provider_sid from accounts where account_sid = ?)`;
const sqlQueryAccountCarrierByName = `SELECT voip_carrier_sid  
FROM voip_carriers vc 
WHERE vc.account_sid = ? 
AND vc.name = ?`;
const sqlQuerySPCarrierByName = `SELECT voip_carrier_sid  
FROM voip_carriers vc 
WHERE vc.account_sid IS NULL 
AND vc.service_provider_sid = 
(SELECT service_provider_sid from accounts where account_sid = ?) 
AND vc.name = ?`;

const speechMapper = (cred) => {
  const {credential, ...obj} = cred;
  if ('google' === obj.vendor) {
    obj.service_key = decrypt(credential);
  }
  else if ('aws' === obj.vendor) {
    const o = JSON.parse(decrypt(credential));
    obj.access_key_id = o.access_key_id;
    obj.secret_access_key = o.secret_access_key;
  }
  else if ('microsoft' === obj.vendor) {
    const o = JSON.parse(decrypt(credential));
    obj.api_key = o.api_key;
    obj.region = o.region;
  }
  return obj;
};

module.exports = (logger, srf) => {
  const {pool}  = srf.locals.dbHelpers;
  const pp = pool.promise();

  const lookupAccountDetails = async(account_sid) => {
    const [r] = await pp.query({sql: sqlAccountDetails, nestTables: true}, account_sid);
    if (0 === r.length) throw new Error(`invalid accountSid: ${account_sid}`);
    const [r2] = await pp.query(sqlSpeechCredentials, account_sid);
    const speech = r2.map(speechMapper);

    /* search at the service provider level if we don't find it at the account level */
    const haveGoogle = speech.find((s) => s.vendor === 'google');
    const haveAws = speech.find((s) => s.vendor === 'aws');
    const haveMicrosoft = speech.find((s) => s.vendor === 'microsoft');
    if (!haveGoogle || !haveAws || !haveMicrosoft) {
      const [r3] = await pp.query(sqlSpeechCredentialsForSP, account_sid);
      if (r3.length) {
        if (!haveGoogle) {
          const google = r3.find((s) => s.vendor === 'google');
          if (google) speech.push(speechMapper(google));
        }
        if (!haveAws) {
          const aws = r3.find((s) => s.vendor === 'aws');
          if (aws) speech.push(speechMapper(aws));
        }
        if (!haveMicrosoft) {
          const ms = r3.find((s) => s.vendor === 'microsoft');
          if (ms) speech.push(speechMapper(ms));
        }
      }
    }

    return {
      ...r[0],
      speech
    };
  };

  const updateSpeechCredentialLastUsed = async(speech_credential_sid) => {
    const pp = pool.promise();
    const sql = 'UPDATE speech_credentials SET last_used = NOW() WHERE speech_credential_sid = ?';
    try {
      await pp.execute(sql, [speech_credential_sid]);
    } catch (err) {
      logger.error({err}, `Error updating last_used for speech_credential_sid ${speech_credential_sid}`);
    }
  };

  const lookupCarrier = async(account_sid, carrierName) => {
    const pp = pool.promise();
    try {
      const [r] = await pp.query(sqlQueryAccountCarrierByName, [account_sid, carrierName]);
      if (r.length) return r[0].voip_carrier_sid;
      const [r2] = await pp.query(sqlQuerySPCarrierByName, [account_sid, carrierName]);
      if (r2.length) return r2[0].voip_carrier_sid;
    } catch (err) {
      logger.error({err}, `lookupCarrier: Error ${account_sid}:${carrierName}`);
    }
  };

  return {
    lookupAccountDetails,
    updateSpeechCredentialLastUsed,
    lookupCarrier
  };
};
