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
    }
    else if ('soniox' === obj.vendor) {
      const o = JSON.parse(decrypt(credential));
      obj.api_key = o.api_key;
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

module.exports = (logger, srf) => {
  const {pool}  = srf.locals.dbHelpers;
  const pp = pool.promise();

  const lookupAccountDetails = async(account_sid) => {

    const [r] = await pp.query({sql: sqlAccountDetails, nestTables: true}, account_sid);
    if (0 === r.length) throw new Error(`invalid accountSid: ${account_sid}`);
    const [r2] = await pp.query(sqlSpeechCredentials, account_sid);
    const speech = r2.map(speechMapper);

    /* add service provider creds unless we have that vendor at the account level */
    const [r3] = await pp.query(sqlSpeechCredentialsForSP, account_sid);
    r3.forEach((s) => {
      if (!speech.find((s2) => s2.vendor === s.vendor)) {
        speech.push(speechMapper(s));
      }
    });

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

  const sqlQueryLcrByAccountSid = `SELECT lcr_sid FROM lcr WHERE account_sid = ? OR
    service_provider_sid = (SELECT service_provider_sid from accounts where account_sid = ?)`;
  const sqlQueryLcrRouteByLcrSid = 'SELECT * FROM lcr_routes WHERE lcr_sid = ? ORDER BY priority';
  const sqlQueryLcrCarrierSetEntryByLcrRouteSid = 'SELECT * FROM lcr_carrier_set_entry WHERE lcr_route_sid = ? ORDER BY priority'
  const lookupCarrierByLcr = async(account_sid, toNumber) => {
    const pp = pool.promise();
    try {
      const[lcrs] = await pp.query(sqlQueryLcrByAccountSid, [account_sid, account_sid]);
      if (lcrs.length) {
        const lcr_sid = lcrs[0];
        const [lcr_routes] = await pp.query(sqlQueryLcrRouteByLcrSid, [lcr_sid]);
        if (lcr_routes.length) {
          for (const r of lcr_routes) {
            var matcher = new RegExp(r.regex);
            if (matcher.test(toNumber)) {
              const [entries] = await pp.query(sqlQueryLcrCarrierSetEntryByLcrRouteSid, [r.lcr_route_sid]);
              // Currently just support first entry;
              if(entries.length) {
                return entries[0].voip_carrier_sid;
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error({error}, `lookupCarrierByLcr: Error ${account_sid}:${toNumber}`);
    }
  }

  return {
    lookupAccountDetails,
    updateSpeechCredentialLastUsed,
    lookupCarrier,
    lookupCarrierByPhoneNumber,
    lookupCarrierByLcr
  };
};
