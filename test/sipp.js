const { spawn } = require('child_process');
const debug = require('debug')('test:sipp');
let network;
const obj = {};
let output = '';
let idx = 1;

function clearOutput() {
  output = '';
}

function addOutput(str) {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 128) output += str.charAt(i);
  }
}

module.exports = (networkName) => {
  network = networkName ;
  return obj;
};

obj.output = () => {
  return output;
};

obj.sippUac = (file, bindAddress, from='sipp', to='16174000000', loop=1) => {
  const cmd = 'docker';
  const args = [
    'run', '-t', '--rm', '--net', `${network}`,
    '-v', `${__dirname}/scenarios:/tmp/scenarios`,
    'drachtio/sipp', 'sipp', '-sf', `/tmp/scenarios/${file}`,
    '-m', loop,
    '-sleep', '250ms',
    '-nostdin',
    '-cid_str', `%u-%p@%s-${idx++}`,
    '172.38.0.50',
    '-key','from', from,
    '-key','to', to, '-trace_msg'
  ];

  if (bindAddress) args.splice(5, 0, '--ip', bindAddress);

  //console.log(args.join(' '));
  clearOutput();

  return new Promise((resolve, reject) => {
    const child_process = spawn(cmd, args, {stdio: ['inherit', 'pipe', 'pipe']});

    child_process.on('exit', (code, signal) => {
      if (code === 0) {
        return resolve();
      }
      console.log(`sipp exited with non-zero code ${code} signal ${signal}`);
      reject(code);
    });
    child_process.on('error', (error) => {
      console.log(`error spawing child process for docker: ${args}`);
    });

    child_process.stdout.on('data', (data) => {
      //console.log(`stdout: ${data}`);
      addOutput(data.toString());
    });
    child_process.stdout.on('data', (data) => {
      // console.log(`stdout: ${data}`);
      addOutput(data.toString());
    });
  });
};
