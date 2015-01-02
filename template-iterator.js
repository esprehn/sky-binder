"use strict";

var iterators = new WeakMap();

function TemplateIterator(templateElement) {
  this.closed = false;
  this.templateElement_ = templateElement;
  this.instanceRef_ = null;
  this.instances = [];
  this.deps = undefined;
  this.iteratedValue = [];
  this.presentValue = undefined;
  this.arrayObserver = undefined;
  iterators.set(templateElement, this);
}

TemplateIterator.prototype = {
  closeDeps: function() {
    var deps = this.deps;
    if (deps) {
      if (deps.ifValue)
        deps.ifValue.close();
      if (deps.value)
        deps.value.close();
    }
  },

  updateDependencies: function(directives, model) {
    this.closeDeps();

    var deps = this.deps = {};
    var template = this.templateElement_;

    this.instanceRef_ = directives.node;

    var ifValue = true;
    var ifProperty = directives.findProperty('if');
    if (ifProperty) {
      deps.hasIf = true;
      deps.ifValue = ifProperty.createObserver(model);
      ifValue = deps.ifValue.open(this.updateIfValue, this);
    }

    var repeatProperty = directives.findProperty('repeat');
    if (repeatProperty) {
      deps.repeat = true;
      deps.value = repeatProperty.createObserver(model);
    }

    var value = deps.value;
    if (!value) {
      value = new observe.PathObserver(model, observe.Path.get(""));
    }

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
    var observe = this.deps.repeat && Array.isArray(value);
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
    var terminator = instance.terminator;
    if (!terminator)
      return this.getLastInstanceNode(index - 1);

    if (!(terminator instanceof Element) ||
        this.templateElement_ === terminator) {
      return terminator;
    }

    var subtemplateIterator = iterators.get(terminator);
    if (!subtemplateIterator)
      return terminator;

    return subtemplateIterator.getLastTemplateNode();
  },

  getLastTemplateNode: function() {
    return this.getLastInstanceNode(this.instances.length - 1);
  },

  insertInstanceAt: function(index, instance) {
    var previousInstanceLast = this.getLastInstanceNode(index - 1);
    var parent = this.templateElement_.parentNode;
    this.instances.splice(index, 0, instance);
    parent.insertBefore(instance.fragment, previousInstanceLast.nextSibling);
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

      instance.fragment.appendChild(parent.removeChild(node));
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
            instance = createInstance(this.instanceRef_, model);
          }
        }

        this.insertInstanceAt(addIndex, instance);
      }
    }

    instanceCache.forEach(function(instance) {
      instance.close();
    });
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
      this.instances[i].close();
    }

    this.instances.length = 0;
    this.closeDeps();
    iterators.delete(this.templateElement_);
    this.closed = true;
  }
};
