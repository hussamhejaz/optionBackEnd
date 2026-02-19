const fs = require('fs');
const path = require('path');

class LocalDatabase {
  constructor() {
    this.data = {};
    this.filePath = path.join(__dirname, '..', 'local-db.json');
    this.load();
  }

  normalizeCollection(collection) {
    if (!Array.isArray(collection)) {
      return collection && typeof collection === 'object' ? collection : {};
    }

    const normalized = {};
    for (const doc of collection) {
      if (!doc || typeof doc !== 'object') continue;
      const id = doc._id || doc.id;
      if (!id) continue;
      normalized[String(id)] = {
        ...doc,
        _id: String(id),
      };
    }
    return normalized;
  }

  normalizeDataShape() {
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
      this.data = {};
      return false;
    }

    let changed = false;
    for (const [name, value] of Object.entries(this.data)) {
      const normalized = this.normalizeCollection(value);
      if (normalized !== value) {
        this.data[name] = normalized;
        changed = true;
      }
    }

    return changed;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(data);
        if (this.normalizeDataShape()) {
          this.save();
        }
      }
    } catch (err) {
      console.warn('Failed to load local database:', err.message);
      this.data = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('Failed to save local database:', err.message);
    }
  }

  collection(name) {
    if (!this.data[name] || typeof this.data[name] !== 'object' || Array.isArray(this.data[name])) {
      this.data[name] = this.normalizeCollection(this.data[name]);
      this.save();
    }
    
    const self = this; // Capture 'this' context
    
    // Query builder for chaining
    const buildQuery = (filters = [], orderByField = null, orderByDir = 'asc', limitCount = null) => ({
      where: (field, op, value) => 
        buildQuery([...filters, { field, op, value }], orderByField, orderByDir, limitCount),
      limit: (count) => 
        buildQuery(filters, orderByField, orderByDir, count),
      orderBy: (field, direction = 'asc') => 
        buildQuery(filters, field, direction, limitCount),
      get: async () => {
        let docs = Object.entries(self.data[name] || {})
          .map(([id, doc]) => ({
            id,
            data: () => doc,
            ref: {
              set: async (updates, opts) => {
                if (opts && opts.merge) {
                  self.data[name][id] = {
                    ...self.data[name][id],
                    ...updates,
                    _updated: new Date().toISOString()
                  };
                } else {
                  self.data[name][id] = {
                    ...updates,
                    _id: id,
                    _created: new Date().toISOString()
                  };
                }
                self.save();
              }
            }
          }));
        
        // Apply filters
        docs = docs.filter(doc => {
          return filters.every(({ field, op, value }) => {
            const docValue = doc.data()[field];
            if (op === '==') {
              return docValue === value;
            }
            return false;
          });
        });
        
        // Apply orderBy
        if (orderByField) {
          docs.sort((a, b) => {
            const aVal = a.data()[orderByField];
            const bVal = b.data()[orderByField];
            let aTime = aVal;
            let bTime = bVal;
            
            if (aVal && typeof aVal === 'object' && 'seconds' in aVal) {
              aTime = aVal.seconds * 1000 + (aVal.nanoseconds || 0) / 1000000;
            } else if (aVal instanceof Date) {
              aTime = aVal.getTime();
            } else if (typeof aVal === 'string') {
              aTime = new Date(aVal).getTime();
            }
            
            if (bVal && typeof bVal === 'object' && 'seconds' in bVal) {
              bTime = bVal.seconds * 1000 + (bVal.nanoseconds || 0) / 1000000;
            } else if (bVal instanceof Date) {
              bTime = bVal.getTime();
            } else if (typeof bVal === 'string') {
              bTime = new Date(bVal).getTime();
            }
            
            if (orderByDir === 'desc') {
              return bTime - aTime;
            }
            return aTime - bTime;
          });
        }
        
        // Apply limit
        if (limitCount) {
          docs = docs.slice(0, limitCount);
        }
        
        return {
          docs,
          forEach: (callback) => docs.forEach(callback),
          size: docs.length
        };
      }
    });
    
    return {
      doc: (id) => {
        if (!id) {
          id = Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        }
        return {
          get: async () => ({
            exists: !!self.data[name][id],
            data: () => self.data[name][id] || null
          }),
          set: async (data, opts = {}) => {
            const shouldMerge = !!(opts && opts.merge);
            const existing = self.data[name][id] || null;
            const createdAt = existing?._created || new Date().toISOString();

            self.data[name][id] = shouldMerge
              ? {
                  ...(existing || {}),
                  ...data,
                  _id: id,
                  _created: createdAt,
                  _updated: new Date().toISOString()
                }
              : {
                  ...data,
                  _id: id,
                  _created: createdAt
                };
            self.save();
          },
          update: async (updates) => {
            if (!self.data[name][id]) {
              throw new Error('Document does not exist');
            }
            self.data[name][id] = {
              ...self.data[name][id],
              ...updates,
              _updated: new Date().toISOString()
            };
            self.save();
          },
          delete: async () => {
            if (!self.data[name][id]) {
              throw new Error('Document does not exist');
            }
            delete self.data[name][id];
            self.save();
          },
          ref: {
            set: async (updates, opts) => {
              if (opts && opts.merge) {
                self.data[name][id] = {
                  ...self.data[name][id],
                  ...updates,
                  _updated: new Date().toISOString()
                };
              } else {
                self.data[name][id] = {
                  ...updates,
                  _id: id,
                  _created: new Date().toISOString()
                };
              }
              self.save();
            }
          },
          id
        };
      },
      where: (field, op, value) => buildQuery([{ field, op, value }]),
      limit: (count) => buildQuery([], null, 'asc', count),
      add: async (data) => {
        const id = Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
        self.data[name][id] = {
          ...data,
          _id: id,
          _created: new Date().toISOString()
        };
        self.save();
        return {
          get: async () => ({
            exists: true,
            data: () => self.data[name][id]
          }),
          id
        };
      },
      get: async () => {
        const docs = Object.entries(self.data[name] || {}).map(([id, doc]) => ({
          id,
          data: () => doc
        }));
        return {
          docs,
          forEach: (callback) => docs.forEach(callback),
          size: docs.length
        };
      },
      orderBy: (field, direction = 'asc') => buildQuery([], field, direction)
    };
  }
}

module.exports = { LocalDatabase };
