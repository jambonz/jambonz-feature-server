const bent = require('bent');

/*
* phoneNumber: 16174000000
* Hook endpoints http://127.0.0.1:3100/
* The function help testcase to register desired jambonz json response for an application call
* When a call has From number match the registered hook event, the desired jambonz json will be responded.
*/
const provisionCallHook = (from, verbs) => {
  const mapping = {
    from,
    data: JSON.stringify(verbs)
  };
  const post = bent('http://127.0.0.1:3100', 'POST', 'string', 200);
  post('/appMapping', mapping);
}

const provisionCustomHook = (from, verbs) => {
  const mapping = {
    from,
    data: JSON.stringify(verbs)
  };
  const post = bent('http://127.0.0.1:3100', 'POST', 'string', 200);
  post(`/customHookMapping`, mapping);
}

const provisionActionHook = (from, verbs) => {
  const mapping = {
    from,
    data: JSON.stringify(verbs)
  };
  const post = bent('http://127.0.0.1:3100', 'POST', 'string', 200);
  post(`/actionHook`, mapping);
}

module.exports = { provisionCallHook, provisionCustomHook, provisionActionHook}
