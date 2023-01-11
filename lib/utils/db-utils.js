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
  try {
    if ('google' === obj.vendor) {
      obj.service_key = decrypt(credential);
    }
    else if ('aws' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.access_key_id = o.access_key_id;
      obj.secret_access_key = o.secret_access_key;
      obj.aws_region = o.aws_region;
    }
    else if ('microsoft' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
      obj.region = o.region;
      obj.use_custom_stt = o.use_custom_stt;
      obj.custom_stt_endpoint = o.custom_stt_endpoint;
      obj.use_custom_tts = o.use_custom_tts;
      obj.custom_tts_endpoint = o.custom_tts_endpoint;
    }
    else if ('wellsaid' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
    }
    else if ('nuance' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.client_id = o.client_id;
      obj.secret = o.secret;
    }
    else if ('ibm' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.tts_api_key = o.tts_api_key;
      obj.tts_region = o.tts_region;
      obj.stt_api_key = o.stt_api_key;
      obj.stt_region = o.stt_region;
    }
    else if ('deepgram' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
    }
  } catch (err) {
    console.log(err);
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
    const haveWellsaid = speech.find((s) => s.vendor === 'wellsaid');
    const haveNuance = speech.find((s) => s.vendor === 'nuance');
    const haveDeepgram = speech.find((s) => s.vendor === 'deepgram');
    const haveIbm = speech.find((s) => s.vendor === 'ibm');
    if (!haveGoogle || !haveAws || !haveMicrosoft || !haveWellsaid || !haveNuance || !haveIbm || !haveDeepgram) {
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
        if (!haveWellsaid) {
          const wellsaid = r3.find((s) => s.vendor === 'wellsaid');
          if (wellsaid) speech.push(speechMapper(wellsaid));
        }
        if (!haveNuance) {
          const nuance = r3.find((s) => s.vendor === 'nuance');
          if (nuance) speech.push(speechMapper(nuance));
        }
        if (!haveDeepgram) {
          const deepgram = r3.find((s) => s.vendor === 'deepgram');
          if (deepgram) speech.push(speechMapper(deepgram));
        }
        if (!haveIbm) {
          const ibm = r3.find((s) => s.vendor === 'ibm');
          if (ibm) speech.push(speechMapper(ibm));
        }
      }
    }

    return {
      ...r[0],
      speech
    };
  };

  const updateSpeechCredentialLastUsed = async(speech_credential_sid) => {
    if (!speech_credential_sid) return;
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
