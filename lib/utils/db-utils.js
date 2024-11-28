const {decrypt} = require('./encrypt-decrypt');

const sqlAccountDetails = `SELECT * 
FROM accounts account 
WHERE account.account_sid = ?`;
const sqlSpeechCredentialsForAccount = `SELECT * 
FROM speech_credentials 
WHERE account_sid = ? OR (account_sid is NULL AND service_provider_sid =  
(SELECT service_provider_sid from accounts where account_sid = ?))`;
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
const sqlQueryAccountPhoneNumber = `SELECT voip_carrier_sid 
FROM phone_numbers pn
WHERE pn.account_sid = ?
AND pn.number = ?`;
const sqlQuerySPPhoneNumber = `SELECT voip_carrier_sid  
FROM phone_numbers pn 
WHERE pn.account_sid IS NULL 
AND pn.service_provider_sid = 
(SELECT service_provider_sid from accounts where account_sid = ?) 
AND pn.number = ?`;
const sqlQueryGoogleCustomVoices = `SELECT *
FROM google_custom_voices
WHERE google_custom_voice_sid = ?`;

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
      obj.role_arn = o.role_arn;
      obj.aws_region = o.aws_region;
    }
    else if ('microsoft' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
      obj.region = o.region;
      obj.use_custom_stt = o.use_custom_stt;
      obj.custom_stt_endpoint = o.custom_stt_endpoint;
      obj.custom_stt_endpoint_url = o.custom_stt_endpoint_url;
      obj.use_custom_tts = o.use_custom_tts;
      obj.custom_tts_endpoint = o.custom_tts_endpoint;
      obj.custom_tts_endpoint_url = o.custom_tts_endpoint_url;
    }
    else if ('wellsaid' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
    }
    else if ('nuance' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.client_id = o.client_id;
      obj.secret = o.secret;
      obj.nuance_tts_uri = o.nuance_tts_uri;
      obj.nuance_stt_uri = o.nuance_stt_uri;
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
      obj.deepgram_stt_uri = o.deepgram_stt_uri;
      obj.deepgram_tts_uri = o.deepgram_tts_uri;
      obj.deepgram_stt_use_tls = o.deepgram_stt_use_tls;
    }
    else if ('soniox' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
    }
    else if ('nvidia' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.riva_server_uri = o.riva_server_uri;
    }
    else if ('cobalt' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.cobalt_server_uri = o.cobalt_server_uri;
    }
    else if ('elevenlabs' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
      obj.model_id = o.model_id;
      obj.options = o.options;
    }
    else if ('playht' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
      obj.user_id = o.user_id;
      obj.voice_engine = o.voice_engine;
      obj.options = o.options;
    }
    else if ('rimelabs' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
      obj.model_id = o.model_id;
      obj.options = o.options;
    }
    else if ('assemblyai' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
    }
    else if ('whisper' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
      obj.model_id = o.model_id;
    }
    else if ('verbio' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.client_id = o.client_id;
      obj.client_secret = o.client_secret;
      obj.engine_version = o.engine_version;
    }
    else if ('speechmatics' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
      obj.speechmatics_stt_uri = o.speechmatics_stt_uri;
    }
    else if (obj.vendor.startsWith('custom:')) {
      const o = JSON.parse(decrypt(credential));
      obj.auth_token = o.auth_token;
      obj.custom_stt_url = o.custom_stt_url;
      obj.custom_tts_url = o.custom_tts_url;
    }
  } catch (err) {
    console.log(err);
  }
  return obj;
};

const bucketCredentialDecrypt = (account) => {
  const { bucket_credential } = account.account;
  if (!bucket_credential || bucket_credential.vendor) return;
  account.account.bucket_credential = JSON.parse(decrypt(bucket_credential));
};

module.exports = (logger, srf) => {
  const {pool}  = srf.locals.dbHelpers;
  const pp = pool.promise();

  const lookupAccountDetails = async(account_sid) => {

    const [r] = await pp.query({sql: sqlAccountDetails, nestTables: true}, [account_sid]);
    if (0 === r.length) throw new Error(`invalid accountSid: ${account_sid}`);
    const [r2] = await pp.query(sqlSpeechCredentialsForAccount, [account_sid, account_sid]);
    const speech = r2.map(speechMapper);

    const account = r[0];
    bucketCredentialDecrypt(account);

    return {
      ...account,
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

  const lookupCarrierByPhoneNumber = async(account_sid, phoneNumber) => {
    const pp = pool.promise();
    try {
      const [r] = await pp.query(sqlQueryAccountPhoneNumber, [account_sid, phoneNumber]);
      if (r.length) return r[0].voip_carrier_sid;
      const [r2] = await pp.query(sqlQuerySPPhoneNumber, [account_sid, phoneNumber]);
      if (r2.length) return r2[0].voip_carrier_sid;
    } catch (err) {
      logger.error({err}, `lookupPhoneNumber: Error ${account_sid}:${phoneNumber}`);
    }
  };

  const lookupGoogleCustomVoice = async(google_custom_voice_sid) => {
    const pp = pool.promise();
    try {
      const [r] = await pp.query(sqlQueryGoogleCustomVoices, [google_custom_voice_sid]);
      return r;

    } catch (err) {
      logger.error({err}, `lookupGoogleCustomVoices: Error ${google_custom_voice_sid}`);
    }
  };

  const lookupVoipCarrierBySid = async(sid) => {
    const pp = pool.promise();
    try {
      const [r] = await pp.query('SELECT * FROM voip_carriers WHERE voip_carrier_sid = ?', [sid]);
      return r;

    } catch (err) {
      logger.error({err}, `lookupVoipCarrierBySid: Error ${sid}`);
    }
  };

  return {
    lookupAccountDetails,
    updateSpeechCredentialLastUsed,
    lookupCarrier,
    lookupCarrierByPhoneNumber,
    lookupGoogleCustomVoice,
    lookupVoipCarrierBySid
  };
};
