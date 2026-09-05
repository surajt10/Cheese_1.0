// Tiny JSON-on-disk store. No dependencies.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, name, defaults = {}) {
    this.file = path.join(dir, `${name}.json`);
    this.defaults = defaults;
    this.data = { ...defaults };
    this._timer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.defaults, ...raw };
      }
    } catch (e) {
      console.error('store load failed', this.file, e);
      this.data = { ...this.defaults };
    }
    return this.data;
  }

  get(key) {
    return key === undefined ? this.data : this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  // Debounced write so rapid state updates don't hammer the disk.
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('store save failed', this.file, e);
    }
  }
}

module.exports = Store;
