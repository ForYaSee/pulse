const Collection = require('./Collection');

module.exports = class Request extends Collection {
  constructor(
    global,
    {
      // request specific
      baseURL,
      requestIntercept,
      responseIntercept,
      mode,
      credentials,
      headers,
      saveHistory
    }
  ) {
    // Before we invoke the parent class, we define some defaults
    let groups = [];
    let persist = ['baseURL'];
    let data = {
      baseURL,
      mode: 'cors',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    };

    if (!baseURL) data.baseURL = null;

    if (headers)
      Object.keys(headers).forEach(header => {
        data.headers[header] = headers[header];
      });

    if (credentials) data.credentials = credentials;
    if (mode) data.mode = mode;

    // Invoke the parent
    super({ name: 'request', global }, { groups, data, persist });

    this._requestIntercept = requestIntercept;
    this._responseIntercept = responseIntercept;

    this._saveHistory = typeof this._saveHistory == 'undefined' ? true : false;

    this._global.request = {
      get: this.get.bind(this),
      post: this.post.bind(this),
      put: this.put.bind(this),
      patch: this.patch.bind(this),
      delete: this.delete.bind(this)
    };
  }

  send(url, method, body, headers) {
    return new Promise((resolve, reject) => {
      const requestHeaders = Object.assign({}, this._public.headers);

      if (headers)
        Object.keys(headers).forEach(header => {
          requestHeaders[header] = headers[header];
        });
			
			// Stringify body
			if (requestHeaders['Content-Type'] !== 'multipart/form-data')
      	body = JSON.stringify(body);

      // If method is not get set application type
      if (method != 'get' && requestHeaders['Content-Type'] === undefined) requestHeaders['Content-Type'] = 'application/json';
			if (requestHeaders['Content-Type'] === 'multipart/form-data') {
				delete requestHeaders['Content-Type'];	
			}
      let fullURL;

      if (url.startsWith('http')) fullURL = url;
      else fullURL = `${this._global.dataRef.request.baseURL}/${url}`;

      // Build options
      this._options = {};
      this._options.credentials = this._global.dataRef.request.credentials;
      this._options.mode = this._global.dataRef.request.mode;

      // Build final fetch options object
      const options = Object.assign(
        {
          headers: requestHeaders,
          method: method.toUpperCase(),
          body: method == 'get' ? null : body
        },
        this._options
      );

      // Invoke request interceptor
      if (this._requestIntercept) this._requestIntercept(options);

      fetch(fullURL, options)
        .then(async response => {
          const contentType = response.headers.get('content-type');

          // extract body
          if (contentType && contentType.indexOf('application/json') !== -1) {
            body = await response.json();
          } else {
            body = await response.text();
          }

          // history
          if (!this._saveHistory)
            this.collect({
              id: Date.now(),
              status: response.status,
              timestamp: new Date(),
              response: body
            });

          // inject headers into prototype
          let final;

          // If response body is an object, create a custom object with response function in prototype, so headers and the full response data can be accessed outside of this class
          if (!Array.isArray(body) && typeof body === 'object') {
            final = Object.create({
              response: () => {
                return response;
              }
            });
            const keys = Object.keys(body);
            for (let i = 0; i < keys.length; i++) {
              const property = keys[i];
              final[property] = body[property];
            }
            // if the body is not an object, we can not inject a prototype, so just return the rew body
          } else {
            final = body;
          }
          // intercept response
          if (this._responseIntercept) this._responseIntercept();

          // reject if bad response status
          if (response.ok || response.redirected) return resolve(final);

          // resolve response
          reject(final);
        })
        .catch(reject);
    });
  }

  get(url, headers) {
    return this.send(url, 'get', {}, headers);
  }
  post(url, body, headers) {
    return this.send(url, 'post', body, headers);
  }
  patch(url, body, headers) {
    return this.send(url, 'patch', body, headers);
  }
  delete(url, body, headers) {
    return this.send(url, 'delete', body, headers);
  }
  put(url, body, headers) {
    return this.send(url, 'put', body, headers);
  }
};
