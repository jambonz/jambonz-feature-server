const assert = require('assert');

//this obj is meant to be mixed in into another class
//NB: it is required that the class have a 'logger' property
module.exports = {
  resources: new Map(),
  addResource(name, resource) {
    this.logger.debug(`addResource: adding ${name}`);

    // duck-typing: resources must have a destroy function and a 'connected' proerty
    assert(typeof resource.destroy === 'function');
    assert('connected' in resource);

    this.resources.set(name, resource);
  },
  getResource(name) {
    return this.resources.get(name);
  },
  hasResource(name) {
    return this.resources.has(name);
  },
  removeResource(name) {
    this.logger.debug(`removeResource: removing ${name}`);
    this.resources.delete(name);
  },
  async clearResource(name) {
    const r = this.resources.get(name);
    if (r) {
      this.logger.debug(`clearResource deleting ${name}`);
      try {
        if (r.connected) r.destroy();
      }
      catch (err) {
        this.logger.error(err, `clearResource error deleting ${name}`);
      }
      this.resources.delete(r);
    }
  },
  async clearResources() {
    for (const [name, resource] of Array.from(this.resources).reverse()) {
      try {
        this.logger.info(`deleting ${name}`);
        if (resource.connected) await resource.destroy();
      } catch (err) {
        this.logger.error(err, `clearResources: error deleting ${name}`);
      }
    }
    this.resources.clear();
  }
};
