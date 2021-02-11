const path = require('path');
const {parseString, writeToString} = require('fast-csv');
const request = require('request-promise-native');
const Base = require('./base');

const CSV_HEADERS = {
  Comment: ['objectId', 'user_id', 'comment', 'insertedAt', 'ip', 'link', 'mail', 'nick', 'pid', 'rid', 'status', 'ua', 'url', 'createdAt', 'updatedAt'],
  Counter: ['objectId', 'time', 'url', 'createdAt', 'updatedAt'],
  Users: ['objectId', 'display_name', 'email', 'password', 'type', 'url', 'avatar', 'github', 'createdAt', 'updatedAt']
};

class Github {
  constructor(repo, token) {
    this.token = token;
    this.repo = repo;
  }

  async get(filename) {
    const resp = await request({
      uri: 'https://api.github.com/repos/' + path.join(this.repo, 'contents', filename),
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: 'token ' + this.token,
        'User-Agent': 'Waline'
      },
      json: true
    });

    return {
      data: Buffer.from(resp.content, 'base64').toString('utf-8'),
      sha: resp.sha
    };
  }

  async set(filename, content, {sha}) {
    return request({
      uri: 'https://api.github.com/repos/' + path.join(this.repo, 'contents', filename),
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: 'token ' + this.token,
        'User-Agent': 'Waline'
      },
      body: JSON.stringify({
        sha,
        message: 'feat(waline): update comment data',
        content: Buffer.from(content, 'utf-8').toString('base64')
      })
    });
  }
}

module.exports = class extends Base {
  constructor(tableName) {
    super();
    this.tableName = tableName;

    const {
      GITHUB_TOKEN, 
      GITHUB_REPO,
      GITHUB_PATH
    } = process.env;
    this.git = new Github(GITHUB_REPO, GITHUB_TOKEN);
    this.basePath = GITHUB_PATH;
  }
  
  async collection(tableName) {
    const filename = path.join(this.basePath, tableName + '.csv');
    const file = await this.git.get(filename).catch(e => {
      if(e.statusCode === 404) {
        return '';
      }
      throw e;
    });
    
    return new Promise((resolve, reject) => {
      const data = [];
      data.sha = file.sha;
      return parseString(file.data, {
        headers: CSV_HEADERS[tableName],
        renameHeaders: true
      })
      .on('error', reject)
      .on('data', row => data.push(row))
      .on('end', _ => resolve(data));
    });
  }

  async save(tableName, data, sha) {
    const filename = path.join(this.basePath, tableName + '.csv');
    const csv = await writeToString(data, {
      headers: CSV_HEADERS[tableName],
      writeHeaders: true
    });
    return this.git.set(filename, csv, {sha});
  }

  where(data, where) {
    if(think.isEmpty(where)) {
      return data;
    }

    const filters = [];
    for(let k in where) {
      if(think.isString(where[k])) {
        filters.push(item => item[k] === where[k]);
        continue;
      }
      if(where[k] === undefined) {
        filters.push(item => item[k] === null || item[k] === undefined);
      }
      if(!Array.isArray(where[k]) || !where[k][0]) {
        continue;
      }
      
      const handler = where[k][0].toUpperCase();
      switch(handler) {
        case 'IN':
          filters.push(item => where[k][1].includes(item));
          break;
        case 'NOT IN':
          filters.push(item => !where[k][1].includes(item));
          break;
        case 'LIKE':
          const first = where[k][1][0];
          const last = where[k][1][-1];
          let reg;
          if(first === '%' && last === '%') {
            reg = new RegExp(where[k][1].slice(1, -1));
          } else if(first === '%') {
            reg = new RegExp(where[k][1].slice(1, -1) + '$');
          } else if(last === '%') {
            reg = new RegExp('^' + where[k][1].slice(1, -1));
          }
          filters.push(item => reg.test(item));
          break;
        case '!=':
          filters.push(item => item !== where[k][1]);
          break;
        case '>':
          filters.push(item => item >= where[k][1]);
          break;
      }
    }

    return filters.reduce((data, fn) => data.filter(fn), data);
  }

  async select(where, {desc, limit, offset, field} = {}) {
    const instance = await this.collection(this.tableName);
    let data = this.where(instance, where);
    if(desc) {
      data.sort((a, b) => {
        if(['insertedAt', 'createdAt', 'updatedAt'].includes(desc)) {
          const aTime = (new Date(a[desc])).getTime();
          const bTime = (new Date(b[desc])).getTime();
          return bTime - aTime;
        }
        return a[desc] - b[desc];
      });
    }

    data = data.slice(limit || 0, offset || data.length);
    if(field) {
      field.push('objectId');
      const fieldObj = {};
      field.forEach(f => (fieldObj[f] = true));
      data = data.map(item => {
        const ret = {};
        for(const k in item) {
          if(fieldObj[k]) {
            ret[k] = item[k];
          }
        }
        return ret;
      });
    }

    return data;
  }

  async count(where = {}, options = {}) {
    const instance = await this.collection(this.tableName);
    const data = this.where(instance, where);
    return data.length;
  }

  async add(data, {
    access: {read = true, write = true} = {read: true, write: true}
  } = {}) {
    const instance = await this.collection(this.tableName);
    data.objectId = Math.random().toString(36).substr(2, 15);
    instance.push(data);
    await this.save(this.tableName, instance, instance.sha);
    return data;
  }

  async update(data, where) {
    delete data.objectId;

    const instance = await this.collection(this.tableName);
    const list = this.where(instance, where);

    list.forEach(item => {
      if(typeof data === 'function') {
        data(item);
      } else {
        for(const k in data) {
          item[k] = data[k];
        }
      }
    });
    await this.save(this.tableName, instance, instance.sha);
  }

  async delete(where) {
    const instance = await this.collection(this.tableName);
    const deleteData = this.where(instance, where);
    const deleteId = deleteData.map(({objectId}) => objectId);
    const data = instance.filter(data => !deleteId.includes(data.objectId));
    await this.save(this.tableName, data, instance.sha);
  }
}