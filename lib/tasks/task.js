const Emitter = require('events');
const debug = require('debug')('jambonz:feature-server');
const assert = require('assert');
const resourcesMixin = require('../utils/resources');
const {TaskPreconditions} = require('../utils/constants');
const specs = new Map();
const _specData = require('./specs');
for (const key in _specData) {specs.set(key, _specData[key]);}

class Task extends Emitter {
  constructor(logger, data) {
    super();
    this.preconditions = TaskPreconditions.None;
    this.logger = logger;
    this.data = data;
  }

  /**
   * called to kill (/stop) a running task
   * what to do is up to each type of task
   */
  kill() {
    // no-op
  }

  static validate(name, data) {
    debug(`validating ${name} with data ${JSON.stringify(data)}`);
    // validate the instruction is supported
    if (!specs.has(name)) throw new Error(`invalid instruction: ${name}`);

    // check type of each element and make sure required elements are present
    const specData = specs.get(name);
    let required = specData.required || [];
    for (const dKey in data) {
      if (dKey in specData.properties) {
        const dVal = data[dKey];
        const dSpec = specData.properties[dKey];
        debug(`Task:validate validating property ${dKey} with value ${JSON.stringify(dVal)}`);

        if (typeof dSpec === 'string' && ['number', 'string', 'object', 'boolean'].includes(dSpec)) {
          // simple types
          if (typeof dVal !== specData.properties[dKey]) {
            throw new Error(`${name}: property ${dKey} has invalid data type`);
          }
        }
        else if (typeof dSpec === 'string' && dSpec === 'array') {
          if (!Array.isArray(dVal)) throw new Error(`${name}: property ${dKey} is not an array`);
        }
        else if (Array.isArray(dSpec) && dSpec[0].startsWith('#')) {
          const name = dSpec[0].slice(1);
          for (const item of dVal) {
            Task.validate(name, item);
          }
        }
        else if (typeof dSpec === 'object') {
          // complex types
          const type = dSpec.type;
          assert.ok(['number', 'string', 'object', 'boolean'].includes(type),
            `invalid or missing type in spec ${JSON.stringify(dSpec)}`);
          if (type === 'string' && dSpec.enum) {
            assert.ok(Array.isArray(dSpec.enum), `enum must be an array ${JSON.stringify(dSpec.enum)}`);
            if (!dSpec.enum.includes(dVal)) throw new Error(`invalid value ${dVal} must be one of ${dSpec.enum}`);
          }
        }
        else if (typeof dSpec === 'string' && dSpec.startsWith('#')) {
          // reference to another datatype (i.e. nested type)
          const name = dSpec.slice(1);
          //const obj = {};
          //obj[name] = dVal;
          Task.validate(name, dVal);
        }
        else {
          assert.ok(0, `invalid spec ${JSON.stringify(dSpec)}`);
        }
        required = required.filter((item) => item !== dKey);
      }
      else throw new Error(`${name}: unknown property ${dKey}`);
    }
    if (required.length > 0) throw new Error(`${name}: missing value for ${required}`);
  }
}

Object.assign(Task.prototype, resourcesMixin);

module.exports = Task;

