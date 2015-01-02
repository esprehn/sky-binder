"use strict";

function TemplateIterator(templateElement) {
  this.closed = false;
  this.templateElement_ = templateElement;
  this.instances = [];
  this.deps = undefined;
  this.iteratedValue = [];
  this.presentValue = undefined;
  this.arrayObserver = undefined;
}

TemplateIterator.prototype = {
  closeDeps: function() {
    var deps = this.deps;
    if (deps) {
      if (deps.ifOneTime === false)
        deps.ifValue.close();
      if (deps.oneTime === false)
        deps.value.close();
    }
  },

  updateDependencies: function(directives, model) {
    this.closeDeps();

    var deps = this.deps = {};
    var template = this.templateElement_;

    var ifValue = true;
    if (directives.if) {
      deps.hasIf = true;
      deps.ifOneTime = directives.if.onlyOneTime;
      deps.ifValue = directives.if.createObserver(model);

      ifValue = deps.ifValue;

      // oneTime if & predicate is false. nothing else to do.
      if (deps.ifOneTime && !ifValue) {
        this.valueChanged();
        return;
      }

      if (!deps.ifOneTime)
        ifValue = ifValue.open(this.updateIfValue, this);
    }

    if (directives.repeat) {
      deps.repeat = true;
      deps.oneTime = directives.repeat.onlyOneTime;
      deps.value = directives.repeat.createObserver(model);
    }

    var value = deps.value;
    if (!value) {
      var bind = parseMustaches('{{}}');
      value = bind.createObserver(model);
    }

    if (!deps.oneTime)
      value = value.open(this.updateIteratedValue, this);

    if (!ifValue) {
      this.valueChanged();
      return;
    }

    this.updateValue(value);
  },

  /**
   * Gets the updated value of the bind/repeat. This can potentially call
   * user code (if a bindingDelegate is set up) so we try to avoid it if we
   * already have the value in hand (from Observer.open).
   */
  getUpdatedValue: function() {
    var value = this.deps.value;
    if (!this.deps.oneTime)
      value = value.discardChanges();
    return value;
  },

  updateIfValue: function(ifValue) {
    if (!ifValue) {
      this.valueChanged();
      return;
    }

    this.updateValue(this.getUpdatedValue());
  },

  updateIteratedValue: function(value) {
    if (this.deps.hasIf) {
      var ifValue = this.deps.ifValue;
      if (!this.deps.ifOneTime)
        ifValue = ifValue.discardChanges();
      if (!ifValue) {
        this.valueChanged();
        return;
      }
    }

    this.updateValue(value);
  },

  updateValue: function(value) {
    if (!this.deps.repeat)
      value = [value];
    var observe = this.deps.repeat &&
                  !this.deps.oneTime &&
                  Array.isArray(value);
    this.valueChanged(value, observe);
  },

  valueChanged: function(value, observeValue) {
    if (!Array.isArray(value))
      value = [];

    if (value === this.iteratedValue)
      return;

    this.unobserve();
    this.presentValue = value;
    if (observeValue) {
      this.arrayObserver = new observe.ArrayObserver(this.presentValue);
      this.arrayObserver.open(this.handleSplices, this);
    }

    this.handleSplices(observe.ArrayObserver.calculateSplices(this.presentValue,
                                                      this.iteratedValue));
  },

  getLastInstanceNode: function(index) {
    if (index == -1)
      return this.templateElement_;
    var instance = this.instances[index];
    var terminator = instance.terminator_;
    if (!terminator)
      return this.getLastInstanceNode(index - 1);

    if (!(terminator instanceof Element) ||
        this.templateElement_ === terminator) {
      return terminator;
    }

    var subtemplateIterator = terminator.iterator_;
    if (!subtemplateIterator)
      return terminator;

    return subtemplateIterator.getLastTemplateNode();
  },

  getLastTemplateNode: function() {
    return this.getLastInstanceNode(this.instances.length - 1);
  },

  insertInstanceAt: function(index, fragment) {
    var previousInstanceLast = this.getLastInstanceNode(index - 1);
    var parent = this.templateElement_.parentNode;
    this.instances.splice(index, 0, fragment);

    parent.insertBefore(fragment, previousInstanceLast.nextSibling);
  },

  extractInstanceAt: function(index) {
    var previousInstanceLast = this.getLastInstanceNode(index - 1);
    var lastNode = this.getLastInstanceNode(index);
    var parent = this.templateElement_.parentNode;
    var instance = this.instances.splice(index, 1)[0];

    while (lastNode !== previousInstanceLast) {
      var node = previousInstanceLast.nextSibling;
      if (node == lastNode)
        lastNode = previousInstanceLast;

      instance.appendChild(parent.removeChild(node));
    }

    return instance;
  },

  handleSplices: function(splices) {
    if (this.closed || !splices.length)
      return;

    var template = this.templateElement_;

    if (!template.parentNode) {
      this.close();
      return;
    }

    observe.ArrayObserver.applySplices(this.iteratedValue, this.presentValue,
                               splices);

    // Instance Removals
    var instanceCache = new Map;
    var removeDelta = 0;
    for (var i = 0; i < splices.length; i++) {
      var splice = splices[i];
      var removed = splice.removed;
      for (var j = 0; j < removed.length; j++) {
        var model = removed[j];
        var instance = this.extractInstanceAt(splice.index + removeDelta);
        if (instance !== emptyInstance) {
          instanceCache.set(model, instance);
        }
      }

      removeDelta -= splice.addedCount;
    }

    // Instance Insertions
    for (var i = 0; i < splices.length; i++) {
      var splice = splices[i];
      var addIndex = splice.index;
      for (; addIndex < splice.index + splice.addedCount; addIndex++) {
        var model = this.iteratedValue[addIndex];
        var instance = instanceCache.get(model);
        if (instance) {
          instanceCache.delete(model);
        } else {
          if (model === undefined) {
            instance = emptyInstance;
          } else {
            instance = createInstance(template, model);
          }
        }

        this.insertInstanceAt(addIndex, instance);
      }
    }

    instanceCache.forEach(function(instance) {
      this.closeInstanceBindings(instance);
    }, this);
  },

  closeInstanceBindings: function(instance) {
    var bindings = instance.bindings_;
    for (var i = 0; i < bindings.length; i++) {
      bindings[i].close();
    }
  },

  unobserve: function() {
    if (!this.arrayObserver)
      return;

    this.arrayObserver.close();
    this.arrayObserver = undefined;
  },

  close: function() {
    if (this.closed)
      return;
    this.unobserve();
    for (var i = 0; i < this.instances.length; i++) {
      this.closeInstanceBindings(this.instances[i]);
    }

    this.instances.length = 0;
    this.closeDeps();
    this.templateElement_.iterator_ = undefined;
    this.closed = true;
  }
};
