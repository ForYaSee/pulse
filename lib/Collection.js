const { Log, assert, warn } = require('./Utils');

// This class is somewhat similar to modules in typical state storage libraries, but instead supports functions.
// It's state is loaded into the main state tree.
module.exports = class Collection {
  constructor(
    { name, global },
    {
      data = {},
      model = {},
      actions = {},
      filters = {},
      indexes = [],
      groups = [],
      routes = {},
      watch = {},
      persist = [],
      onLoad
    }
  ) {
    this._name = name;

    this._actionRefrence = {
      collect: this.collect.bind(this),
      undo: this.undo.bind(this),
      move: this.move.bind(this),
      update: this.update.bind(this),
      put: this.put.bind(this),
      delete: this.delete.bind(this),
      findById: this.findById.bind(this),
      getGroup: this.getGroup.bind(this),
      newGroup: this.newGroup.bind(this),
      forceUpdate: this.forceUpdate.bind(this),
      throttle: this.throttle.bind(this),
      set: this.set.bind(this)
    };

    // this is used to pass the collections public properties into other collections without creating a circular refrence for the entire collection. It also helps control namespace.
    const publicObject = Object.assign(
      {
        groups: {},
        data: {},
        actions: {},
        filters: {},
        routes: {},
        indexes: {}
      },
      this._actionRefrence
    );
    this._public = this.initProxy(publicObject);

    this._global = global;
    this._regenQueue = this._global.regenQueue;

    this._onLoad = onLoad;
    this._model = model; // the model for validating data
    this._filters = filters;

    this._data = {}; // the internal data store
    this._indexes = {}; // arrays of primary keys
    // direct or dynamic data relation to filters
    this._filtersRelatedToData = {};
    this._filtersRelatedToGroup = {};

    this._relations = {};
    this._subscribedToData = {};

    this._throttles = [];
    this._mutableData = [];
    this._indexesToRegen = [];
    this._filtersToForceRegen = [];

    this._collectionSize = 0;
    this._primaryKey = null;

    this._executing = false;
    this._collecting = false;
    this._performingAction = false;
    this._allowInternalChange = false;

    // so other collections can access this collection's internal data
    this._global.internalDataRef[this._name] = this._data;

    this._storage = {};
    this._storage.get = key => JSON.parse(this._global.storage.get(key));
    this._storage.set = (key, value) =>
      this._global.storage.set(key, JSON.stringify(value));
    // this._storage.remove = prepareStorage.remove.bind(_storage);
    // this._storage.clear = prepareStorage.clear.bind(_storage);

    // analyse the model
    this.parseModel(model);

    // initialize routes & actions
    this.initData(data);
    this.initGroups(indexes.concat(groups));
    this.initRoutes(routes);
    this.initFilters(filters);
    this.initActions(actions);

    this.watchers = watch;

    this.prepareNamespace();

    this.initPersist(persist);
  }

  parseModel(model) {
    Object.keys(model).forEach(property => {
      Object.keys(model[property]).forEach(config => {
        if (config === 'primaryKey') {
          this._primaryKey = property;
        } else if (config === 'parent') {
          this.createDataRelation(
            property,
            model[property].parent,
            model[property].assignTo
          );
        }
      });
    });
  }

  createDataRelation(primaryKeyName, fromCollectionName, assignTo) {
    // if this is a valid collection
    if (!this._global.collectionNamespace.includes(fromCollectionName))
      return assert(`"${collection}" is not a valid collection.`);
    // create an object for group names, which will contain arrays of primary keys
    this._relations[primaryKeyName] = {};
    this._relations[primaryKeyName].fromCollectionName = fromCollectionName;
    if (assignTo) this._relations[primaryKeyName].assignTo = assignTo;
  }

  initGroups(indexes) {
    this._public.groups = this.initProxy({});
    for (let index of indexes) {
      if (this._public.groups[index] || this._indexes[index])
        return assert(`Duplicate declaration for index ${index}`);
      // create a new empty array for the index
      this._indexes[index] = new Array();
      this._public.groups[index] = new Array();
    }
  }

  initData(data) {
    Object.keys(data).forEach(key => this._mutableData.push(key));
    this._public.data = this.initProxy(data);
  }

  initFilters(filters) {
    // map filters
    let loop = Object.keys(filters);
    this._public.filters = this.initProxy({});
    for (let filterName of loop) {
      // set the property to an empty array, until we've parsed the filter
      this._public.filters[filterName] = [];
      this._global.allFilters.push(filterName);
    }
  }

  initRoutes(routes) {
    let loop = Object.keys(routes);
    for (let routeName of loop) {
      this._public.routes[routeName] = customParam => {
        return routes[routeName](this._global.request, customParam);
      };
    }
  }

  initActions(actions) {
    let loop = Object.keys(actions);
    for (let actionName of loop) {
      // if (this.checkNamespace(actionName)) {
      // build a wrapper around the action to provide it data and intercept usage
      this._public.actions[actionName] = customParam => {
        if (this._throttles.includes(actionName)) return Promise.reject();

        // declare action is running
        this._performingAction = actionName;

        const context = Object.assign(
          {
            data: this._public.data,
            filters: this._public.filters,
            groups: this._public.groups,
            actions: this._public.actions,
            routes: this._public.routes
          },
          this._global.dataRef,
          this._actionRefrence
        );

        // run action
        let runAction = actions[actionName](context, customParam);

        // declare action has finsihed
        this._performingAction = false;

        return runAction;
      };
      // }
    }
  }

  throttle(amount) {
    // preserve current action name on invoke
    let actionToThrottle = this._performingAction;
    this._throttles.push(actionToThrottle);
    setTimeout(() => {
      this._throttles = this._throttles.filter(
        action => action !== actionToThrottle
      );
    }, amount);
  }

  initPersist(persist = []) {
    this._persist = [];
    for (let property of persist) {
      this._persist.push(property);
      let storageKey = `_${this._name}_${property}`;
      // find property in storage
      if (!this._public.hasOwnProperty(property))
        return assert(
          `Unable to persist property "${property}" as it does not exist.`
        );
      let type = this.searchNamespaceForProperty(property);
      if (this._storage.get(storageKey)) {
        if (type) {
          this._allowInternalChange = true;
          this._public[type][property] = this._storage.get(storageKey);
          this._allowInternalChange = false;

          if (this._public.hasOwnProperty(property)) {
            this._allowInternalChange = true;
            this._public[property] = this._storage.get(storageKey);
            this._allowInternalChange = false;
          }
        } else {
          assert(`Unable to persist. Could not determin property type.`);
        }
      } else {
        if (type) {
          this._storage.set(storageKey, this._public[type][property]);
        }
      }
    }
  }

  // returns the address of a public property
  searchNamespaceForProperty(property) {
    // debugger;
    let searchable = ['filters', 'data', 'groups'];
    for (let type of searchable) {
      if (Object.keys(this._public[type]).includes(property)) {
        return type;
      }
    }
    return false;
  }

  validateNamespace(context, property) {
    Object.keys(context).forEach(prop => {
      if (context.hasOwnProperty(property)) {
        warn(`Duplicate property "${property}" on collection "${this._name}"`);
        return false;
      }
    });
    return true;
  }

  // reserves the namespace on the component instance before runtime
  prepareNamespace() {
    // settings here..
    Object.keys(this._public).forEach(category => {
      if (['data', 'actions', 'groups', 'filters'].includes(category)) {
        Object.keys(this._public[category]).forEach(item => {
          if (this.validateNamespace(this._public, item))
            this._public[item] = this._public[category][item];
        });
      }
    });
  }

  initProxy(obj = {}, rootProperty = false) {
    let customProto = Object.prototype;
    // customProto.rootProperty = rootProperty;
    let objectWithCustomPrototype = Object.create({
      rootProperty
    });

    for (let property of Object.keys(obj)) {
      objectWithCustomPrototype[property] = obj[property];
    }
    return new Proxy(objectWithCustomPrototype, {
      set: (target, key, value) => {
        // during initialization, allow proxy to be edited without intercepting
        if (!this._global.initComplete) {
          target[key] = value;
        } else if (this._allowInternalChange === true) {
          this._allowInternalChange = false;
          // only update dependencies if pulse has finished initalizing and the data is not a filter or index
          Log(`Internally mutating value ${key}`);
          target[key] = value;
        } else if (this._mutableData.includes(key)) {
          Log(`User mutated data: "${key}"`);

          target[key] = value;

          this.analyseChildProperties(target, key, value);
          // first push the change
          this.updateSubscribers(key, value);
          // now process any dependents that are affected by this change
          this.findAndUpdateDependents(key);
        } else if (Object.getPrototypeOf(target).rootProperty) {
          let rootProperty = Object.getPrototypeOf(target).rootProperty;

          if (this._mutableData.includes(rootProperty)) {
            target[key] = value;
            this.updateSubscribers(rootProperty, this._public[rootProperty]);
            this.findAndUpdateDependents(rootProperty);
          }
        } else {
          assert(
            `Cannot set data property "${key}" in collection "${
              this._name
            }" as "${key}" does not exist.`
          );
        }
        return true;
      },
      get: (target, key, value) => {
        if (
          this._global.record &&
          // prevent proxy from reporting access to these properties, as they have their own proxy
          !['filters', 'groups', 'indexes', 'data', 'actions'].includes(key) &&
          this._global.dependenciesFound.filter(
            item => item.property === key && item.collection === this._name
          ).length === 0
        ) {
          this._global.dependenciesFound.push({
            property: key,
            collection: this._name
          });
        }
        return target[key];
      }
    });
  }

  analyseChildProperties(target, key, value) {
    function isObject(obj) {
      return typeof obj === 'object' && !Array.isArray(obj);
    }
    if (isObject(value)) {
      for (let child of Object.keys(value)) {
        // add proxy level one
        let rootProperty;
        if (Object.getPrototypeOf(target).rootProperty) {
          rootProperty = Object.getPrototypeOf(target).rootProperty;
        } else {
          rootProperty = key;
        }
        this._allowInternalChange = true;
        this._public[key] = this.initProxy(value, rootProperty);
        this._allowInternalChange = false;
      }
    }
  }

  checkNamespace(name) {
    const avalible = !!this._public.data.hasOwnProperty(name);
    if (!avalible) {
      assert(
        `Namespace error "${name}" is already taken for collection "${
          this._name
        }".`
      );
      return false;
    }
    return true;
  }

  // this is called by the main class once all collections have been constructed, it runs through each filter, executing the function. It  then uses the data proxy to detect which properties the filter wants to access, and saves them in a dependency graph. NOTE: If the filter has an if statement, and a property is
  analyseFilters() {
    if (!this._filters) return;
    let loop = Object.keys(this._filters);
    for (let filter of loop) {
      this.executeAndAnalyseFilter(filter);
    }
  }
  // this is called by the local analyseFilters() loop and the main class during regen queue processing
  executeAndAnalyseFilter(filter) {
    Log(`Analysing filter "${filter}"`);
    // open the door allowing each collection's data proxy to record which properties are accessed by this filter
    this._global.record = true;

    // execute the filter
    this.executeFilter(filter);

    // data recorded, close door
    let found = this._global.dependenciesFound;

    // empty the list of dependencies for next loop
    this._global.dependenciesFound = [];

    // preliminarily loop over dependencys to find missing dependents
    for (let dependency of found) {
      if (this.checkForMissingDependency(dependency, filter))
        // don't register anything to dependency graph, this will get done once all depenecies are clear, avoids us having to check or prevent dependency graph from having duplicate entries.
        return;
    }
    this.populateDependencies(found, filter);

    // mark is as generated so other filters know they are in the clear!
    this._global.generatedFilters.push(this._name + filter);
    Log(`Generated ${filter} for collection ${this._name}`);
  }

  populateDependencies(found, filter) {
    let depGraph = this._global.dependencyGraph;
    for (let dependency of found) {
      // Register dependencies of this filter, only filters have this.
      let key1 = `${dependency.collection}/${dependency.property}`;
      let location1 = depGraph[this._name][filter];

      if (!location1.dependencies.includes(key1)) {
        location1.dependencies.push(key1);
      }
      // register this filter as a dependent for the foreign filter or data property
      let key2 = `${this._name}/${filter}`;
      let location2 = depGraph[dependency.collection][dependency.property];

      if (
        location2 &&
        location2.dependents &&
        !location2.dependents.includes(key2)
      ) {
        location2.dependents.push(key2);
      }
    }
  }

  parseKey(key) {
    return {
      collection: key.split('/')[0],
      property: key.split('/')[1]
    };
  }

  // ensure it is a filter that has not been generated yet, if it hasn't we should save it to the queue to be checked again after more have been analysed
  checkForMissingDependency(dependency, filter) {
    let glob = this._global;
    if (
      // ensure the dependency is a filter, not an index (group). Indexes should be regenerated before the regen queue is processed. This could be removed if you make the regen queue regen indexes too.
      glob.allFilters.includes(dependency.property) &&
      !glob.generatedFilters.includes(
        dependency.collection + dependency.property
      )
    ) {
      Log(
        `Dependent "${
          dependency.property
        }" has not been analysed yet, saving this filter to regen queue.`
      );
      this._regenQueue.push({
        type: 'filter',
        property: filter,
        collection: this._name
      });
      return true;
    }
    return false;
  }

  // this function returns all the dependents decending from a particular filter
  findAllDependents(filter) {
    const graph = this._global.dependencyGraph;
    const dependents = graph[this._name][filter].dependents;
    const dependenciesFound = [];
    let loops = 0;
    let lastRound = [];
    for (let dep of dependents) {
      lastRound.push(dep);
      dependenciesFound.push(dep);
    }
    const loop = () => {
      loops++;
      let loopChildren = lastRound;
      lastRound = [];
      for (let dep of loopChildren) {
        let depParsed = this.parseKey(dep);
        let search = graph[depParsed.collection][depParsed.property].dependents;
        for (let childDep of search) {
          lastRound.push(childDep);
          dependenciesFound.push(childDep);
        }
      }
      if (loops > 1000)
        return assert(`Maximum stack exceeded for dependent search.`);
      else if (lastRound.length !== 0) loop();
    };
    loop();
    return dependenciesFound;
  }

  // this function should run when any data is changed. It will find all filters that need to be regnerated now that the parent data has changed.
  findAndUpdateDependents(propertyChanged) {
    let allDependents = [];
    if (Array.isArray(propertyChanged)) {
      for (let i of propertyChanged) {
        let deps = this.findAllDependents(i);
        for (let dep of deps)
          if (!allDependents.includes(dep)) allDependents.push(dep);
      }
    } else {
      allDependents = this.findAllDependents(propertyChanged);
    }
    Log(`Found dependents: ${JSON.stringify(allDependents)}`);
    this.pushDependentsToRegenQueue(allDependents);
  }

  pushDependentsToRegenQueue(dependentFilters) {
    for (let filter of dependentFilters) {
      let parsedFilter = this.parseKey(filter);
      // check if already in regen queue
      if (
        !this._regenQueue.find(
          item =>
            item.property === parsedFilter.property &&
            item.collection === parsedFilter.collection
        )
      ) {
        // add to queue
        this._regenQueue.push({
          type: 'filter',
          property: parsedFilter.property,
          collection: parsedFilter.collection
        });
      }
    }
    // send a message back to the main class. Refrencing would be impossible without creating a circular refrence, so to avoid that we use proxies to trigger events
    this._global.eventBus.message = 'processRegenQueue';
  }

  forceUpdate(filter) {
    this._regenQueue.push({
      type: 'filter',
      property: filter,
      collection: this._name
    });
    this._global.eventBus.message = 'processRegenQueue';
  }

  executeFilter(filter) {
    this._executing = filter;

    const context = Object.assign(
      {
        data: this._public.data,
        filters: this._public.filters,
        groups: this._public.groups,
        actions: this._public.actions
      },
      this._global.dataRef,
      this._actionRefrence
    );

    let data = this._filters[filter](context);

    this._executing = false;
    // filter executed, now ensure the door is closed before deliverUpdate, as that will trigger the proxy's set trap- and with this still true it will cause an infinate loop.
    this._global.record = false;
    // if the result of the filter is null or undefined, chang
    if (data === undefined || data === null) data = false;
    // update subscribers
    this.deliverUpdate('filters', data, filter);
  }

  // this will fill the index array with the correposonding data and include relational data
  buildGroupFromIndex(index) {
    // constuct the data from the index
    let data = this._indexes[index].map(id => {
      let data = this._data[id];
      for (let relationKey of Object.keys(this._relations)) {
        let rel = this._relations[relationKey];
        // debugger;
        let assignTo = rel.hasOwnProperty('assignTo') ? rel.assignTo : false;

        if (data.hasOwnProperty(relationKey)) {
          let foreignData = this._global.internalDataRef[
            rel.fromCollectionName
          ][data[relationKey]];

          if (foreignData) {
            if (assignTo) data[assignTo] = foreignData;
            else data[rel.fromCollectionName] = foreignData;
          }
        }
      }
      return data;
    });

    if (
      this._public.hasOwnProperty(index) ||
      this._public.groups.hasOwnProperty(index)
    )
      // deliver data to public object
      this.deliverUpdate('groups', data, index);

    // update public index refrence
    this._allowInternalChange = true;
    this._public.indexes[index] = this._indexes[index];
    this._allowInternalChange = false;

    // return data for functions like "findGroup"
    return data;
  }

  deliverUpdate(type, data, name) {
    // process update, allowInternalChange instructs Proxy to bypass user mutation validation and to not search for dependents to update, as it is already taken care of
    this._allowInternalChange = true;
    this._public[type][name] = data;
    this._allowInternalChange = false;
    // update root namespaces, eventually add setting here for users that want to disable root namespace assignment
    if (this._public.hasOwnProperty(name)) {
      this._allowInternalChange = true;
      this._public[name] = data;
      this._allowInternalChange = false;
    }
    this.updateSubscribers(name, data);
  }

  updateSubscribers(key, data) {
    Log(`Updating subscribers for ${key}`);
    // trigger watcher for data
    if (this.watchers.hasOwnProperty(key))
      // push to bottom of call stack to ensure dependencies have generated
      setTimeout(() => this.watchers[key](this._global.dataRef));
    // persist data if need be
    this.persistData(key, data);

    if (this._subscribedToData[key])
      for (let item of this._subscribedToData[key]) {
        item.component.$set(item.component, item.key, data);
      }
  }

  persistData(key, value) {
    if (this._persist.includes(key)) {
      let storageKey = `_${this._name}_${key}`;
      Log(`Persisting data with key ${storageKey}`);
      this._storage.set(storageKey, value);
    }
  }

  createRelationForIndex(index) {
    for (let primaryKey of Object.keys(this._relations))
      this._relations[primaryKey][index] = [];
  }

  collect(data, index) {
    // validate
    if (!data)
      return assert(
        `Collect error on collection ${this._name}: Data undefined`
      );
    if (!Array.isArray(data)) data = [data];

    this._collecting = true;
    let indexIsArray = false;
    let indexesModified = [];
    let indexesCreated = [];

    // create the index
    if (index) {
      if (Array.isArray(index)) {
        indexIsArray = true;
        for (let i of index) {
          this.createRelationForIndex(i);
          this._indexesToRegen.push(i);
          if (!this._indexes[i]) {
            this._indexes[i] = [];
          }
          indexesModified.push(i);
        }
      } else {
        this.createRelationForIndex(index);
        this._indexesToRegen.push(index);
        if (!this._indexes[index]) {
          this._indexes[index] = [];
        }
        indexesCreated.push(index);
      }
    }
    // process the data
    if (!Array.isArray(data)) this.processDataItem(data, index);
    else for (let item of data) this.processDataItem(item, index, data);

    // update any existing indexes where data has been added

    // record the changes
    this.recordHistory('collect', {
      dataCollected: data,
      indexesCreated,
      indexesModified
    });

    this._collecting = false;
    Log(`Collected ${data.length} items. With index: ${index}`);

    this.regenerateGroupsAndFilters();
  }

  processDataItem(data, index) {
    // validate against model
    // if no primary key defined in the model, search for a generic one.
    if (!this._primaryKey) this.findPrimaryKey(data);

    // if that primary key does not exist on this data item, reject.
    if (!data.hasOwnProperty(this._primaryKey))
      this.dataRejectionHandler(data, 'Primary key mismatch');

    // check if we already have the data
    if (this._data[data[this._primaryKey]]) {
      // see if it exists on any other indexes?
    }

    // push id into index provided it doesn't already exist on that index
    if (index && !this._indexes[index].includes(data[this._primaryKey])) {
      this._indexes[index].push(data[this._primaryKey]);
    }

    for (let relationKey of Object.keys(this._relations)) {
      let relation = this._relations[relationKey];
      if (Array.isArray(relation[index]))
        relation[index].push(data[relationKey]);
    }

    // if we've already collected this item, it may exist in other indexes, so regenerate those.
    // (bug: hasOwnProperty didn't work here)
    if (Object.keys(this._data).includes(data[this._primaryKey]))
      this.findGroupsToRegen(data[this._primaryKey]);

    // Some filters might have direct links to this piece of data or index (EG: "getGroup()" or "findByID()")
    this.findFiltersToRegen(data[this._primaryKey], index);

    // add the data internally
    this._data[data[this._primaryKey]] = data;
    this._collectionSize++;
  }

  findGroupsToRegen(primaryKey) {
    Log(`looking for indexes for ${primaryKey}`);
    // check existing indexes for primary key id, here is where we determin which, if any, indexes need to be regenerated
    let loop = Object.keys(this._indexes);
    for (let indexName of loop) {
      if (
        // the data item exists already in another index
        this._indexes[indexName].includes(primaryKey) &&
        // we haven't already established this index needs regeneration
        !this._indexesToRegen.includes(indexName)
      ) {
        this._indexesToRegen.push(indexName);
      }
    }
  }

  findFiltersToRegen(primaryKey, indexes) {
    //
    const findFilters = (source, index) => {
      Object.keys(this[source]).forEach(filterName => {
        if (this[source][filterName].includes(index)) {
          // push the filter to the regen queue, but only if it is not already there.
          if (!this._filtersToForceRegen.includes(filterName))
            this._filtersToForceRegen.push(filterName);
        }
      });
    };

    // for several indexes
    if (Array.isArray(indexes))
      for (let index of indexes) findFilters('_filtersRelatedToGroup', index);
    // for a singular index
    else findFilters('_filtersRelatedToGroup', indexes);
    // for singular data
    findFilters('_filtersRelatedToData', primaryKey);
  }

  regenerateGroupsAndFilters() {
    // add the indexes to the regen queue first
    for (let i of this._indexesToRegen) {
      Log(`Rebuilding index ${i}`);
      let index = this._indexesToRegen.shift();
      this.buildGroupFromIndex(index);
      // any filters dependent on the indexes we've added data too should be regenerated
      if (this._global.dataRef[this._name][index])
        this.findAndUpdateDependents(index);
    }
    // check for filters to force regen and push them to the regen queue. The regen queue will not accept the same filter twice, so if the dependency graph finds this filter too, it won't generate twice.
    let filtersToForceRegenEncoded = [];
    for (let filter of this._filtersToForceRegen)
      filtersToForceRegenEncoded.push(`${this._name}/${filter}`);
    // the regen queue function need the filter concat with the collection name
    this.pushDependentsToRegenQueue(filtersToForceRegenEncoded);
    // clean up once sent
    this._filtersToForceRegen = [];
  }

  findPrimaryKey(item) {
    let genericPrimaryIds = ['id', '_id'];
    // detect a primary key
    for (let key of genericPrimaryIds) {
      if (item.hasOwnProperty(key)) this._primaryKey = key;
    }
    if (!this._primaryKey)
      this.dataRejectionHandler(item, 'No primary key supplied.');
  }

  // Source data has been modified, these are the functions that will update the relevent indexes and filters to regnerate
  internalDataModified(primaryKey) {
    this.findGroupsToRegen(primaryKey);
    this.findFiltersToRegen(primaryKey);
    this.regenerateGroupsAndFilters();
  }

  // this function
  undo() {
    Log('undo requested, coming soon!');
  }

  // move data by id (or array of IDs) into another index
  move(ids, sourceIndex, destIndex) {
    // Validate
    if (!this._indexes[sourceIndex])
      return assert(`Index "${sourceIndex}" not found`);
    if (!this._indexes[destIndex])
      return assert(`Index "${destIndex}" not found`);
    if (!Array.isArray(ids)) ids = [ids];

    // record previous values
    let history = {
      ids,
      previousSourceIndex: sourceIndex,
      previousDestIndex: destIndex
    };

    // make changes
    for (let id of ids) {
      if (!this._data[id])
        return assert(
          `Data for id "${id}" not found in collection ${this._name}`
        );

      // remove from source index
      this._indexes[sourceIndex] = this._indexes[sourceIndex].filter(
        item => item !== id
      );

      //add to dest index
      this._indexes[destIndex].push(id);
    }

    // rebuild groups
    this.buildGroupFromIndex(sourceIndex);
    this.buildGroupFromIndex(destIndex);

    // record history
    this.recordHistory('move', history);

    // update dependents
    this.findAndUpdateDependents([sourceIndex, destIndex]);
  }

  // put data by id (or array of IDs) into another index
  put(ids, destIndex) {
    // Validate
    if (!this._indexes[destIndex])
      return assert(`Index "${destIndex}" not found`);
    if (!Array.isArray(ids)) ids = [ids];

    // record previous value
    let previousDestIndex = Object.assign({}, this._indexes[destIndex]);

    // Loop
    for (let id of ids) {
      if (!this._data[id])
        return assert(
          `Data for id "${id}" not found in collection ${this._name}`
        );
      this._indexes[destIndex].push(id);
    }

    this.buildGroupFromIndex(destIndex);

    this.recordHistory('put', {
      ids,
      previousDestIndex
    });

    this.findAndUpdateDependents(destIndex);
  }

  // change single or multiple properties in your data
  update(id, propertiesToChange) {
    if (this._data[id]) {
      let data = this._data[id];

      let loop = Object.keys(propertiesToChange);

      let history = {
        dataId: id,
        previousValues: {},
        newValues: propertiesToChange
      };

      for (let property of loop) {
        if (!data.hasOwnProperty(property))
          assert(`Data "${id}" does not have property "${property}" to update`);

        history.previousValues[property] = data[property];

        data[property] = propertiesToChange[property];
      }

      this.recordHistory('update', history);

      this.internalDataModified(id);
    } else {
      assert(`Data for id "${id}" not found in collection ${this._name}`);
    }
  }

  findById(id) {
    // if called from within a filter create an internal index tied to this filter, this will mean when the data is changed we can regenerate this filter
    if (this._executing) this._filtersRelatedToData[this._executing] = [id];
    // if filtername is not specified, it was called from outside, in which case could never be reactive
    if (this._data[id]) return this._data[id];
    else {
      // this can be hooked on the collection config
      // this.emit('onMissingId', id)
      Log(`findByID: Item "${id}" not found in collection "${this._name}"`);
    }
  }

  getGroup(id) {
    if (this._executing) this._filtersRelatedToGroup[this._executing] = [id];

    if (this._indexes[id]) return this.buildGroupFromIndex(id);
    else return [];
  }

  newGroup(name, indexArray) {
    if (!Object.keys(this._indexes).includes(name)) {
      this._indexes[name] = indexArray;

      this.recordHistory('newGroup', {
        createdGroup: name,
        data: indexArray
      });
    }
  }

  modifyGroup(group) {}

  // removes data via primary key from a collection
  delete(items) {
    const deleteFunction = primaryKey => {
      // if (!Object.keys(this._data).includes(primaryKey)) return;
      let deletedData = Object.assign({}, this._data.primaryKey);
      delete this._data[primaryKey];

      this.recordHistory('delete', {
        deleted: deletedData
      });

      this.internalDataModified(primaryKey);
    };
    if (Array.isArray(items))
      for (let primaryKey of items) deleteFunction(primaryKey);
    else deleteFunction(items);
  }

  clean() {}

  increment(primaryKey, property, amount) {
    if (!validateNumberForDataProperty(primaryKey, property, amount)) return;

    this._data[primaryKey][property] += amount;

    this.recordHistory('increment', {
      previousValue: amount
    });

    this.internalDataModified(primaryKey);
  }

  decrement(primaryKey, property, amount) {
    if (!validateNumberForDataProperty(primaryKey, property, amount)) return;

    this._data[primaryKey][property] -= amount;

    this.recordHistory('decrement', {
      previousValue: amount
    });

    this.internalDataModified(primaryKey);
  }

  set(target, mutation) {
    console.log(target, mutation);
  }

  validateNumberForDataProperty(primaryKey, property, amount) {
    if (
      !this._data[primaryKey] ||
      !this._data[primaryKey][property] ||
      typeof amount !== 'number' ||
      typeof this._data[primaryKey][property] !== 'number'
    ) {
      assert(`Property ${property} for ${primaryKey} is not a number`);
      return false;
    }
    return true;
  }

  // used to save errors to the instance
  dataRejectionHandler(data, message) {
    let error = `[Data Rejection] - ${message} - Data was not collected, but instead saved to the errors object("_errors") on root Pulse instance.`;
    this._global.errors.push({
      data,
      timestamp: new Date(),
      error
    });
    assert(error);
  }

  recordHistory(type, data) {
    let historyItem = {
      type,
      timestamp: Date.now(),
      collection: this._name,
      fromAction: this._performingAction,
      data
    };
    this._global.history.push(historyItem);
  }
};
