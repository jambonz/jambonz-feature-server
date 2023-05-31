const bent = require('bent');

/*
* phoneNumber: 16174000000
* Hook endpoints http://127.0.0.1:3100/
* The function help testcase to register desired jambonz json response for an application call
* When a call has From number match the registered hook event, the desired jambonz json will be responded.
*/
const provisionCallHook = async (from, verbs) => {
  const mapping = {
    from,
    data: JSON.stringify(verbs)
  };
  const post = bent('http://127.0.0.1:3100', 'POST', 'string', 200);
  await post('/appMapping', mapping);
}

const provisionCustomHook = async(from, verbs) => {
  const mapping = {
    from,
    data: JSON.stringify(verbs)
  };
  const post = bent('http://127.0.0.1:3100', 'POST', 'string', 200);
  await post(`/customHookMapping`, mapping);
}

const provisionActionHook = async(from, verbs) => {
  const mapping = {
    from,
    data: JSON.stringify(verbs)
  };
  const post = bent('http://127.0.0.1:3100', 'POST', 'string', 200);
  await post(`/actionHook`, mapping);
}

const provisionAnyHook = async(key, verbs) => {
  const mapping = {
    key,
    data: JSON.stringify(verbs)
  };
  const post = bent('http://127.0.0.1:3100', 'POST', 'string', 200);
  await post(`/anyHookMapping`, mapping);
}

module.exports = { provisionCallHook, provisionCustomHook, provisionActionHook, provisionAnyHook}
