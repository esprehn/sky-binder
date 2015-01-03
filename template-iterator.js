"use strict";
(function() {

var iterators = new WeakMap();

class TemplateIterator {
  constructor(templateElement) {
    this.closed = false;
    this.template = templateElement;
    this.contentTemplate = null;
    this.instances = [];
    this.deps = {
      hasRepeat: false,
      ifValue: null,
      value: null,
    };
    Object.preventExtensions(this.deps);
    this.iteratedValue = [];
    this.presentValue = undefined;
    this.arrayObserver = undefined;
    iterators.set(templateElement, this);
    Object.preventExtensions(this);
  }

  closeDeps() {
    var deps = this.deps;
    if (deps.ifValue)
      deps.ifValue.close();
    if (deps.value)
      deps.value.close();
  }

  updateDependencies(directives, model) {
    var deps = this.deps;

    this.contentTemplate = directives.node;

    var ifValue = true;
    var ifProperty = directives.findProperty('if');
    if (ifProperty) {
      deps.ifValue = ifProperty.createObserver(model);
      ifValue = deps.ifValue.open(this.updateIfValue, this);
    }

    var repeatProperty = directives.findProperty('repeat');
    if (repeatProperty) {
      deps.hasRepeat = true;
      deps.value = repeatProperty.createObserver(model);
    } else {
      deps.value = new observe.PathObserver(model, observe.Path.get(""));
    }

    var value = deps.value.open(this.updateIteratedValue, this);
    this.updateValue(ifValue ? value : null);
  }

  getUpdatedValue() {
    var value = this.deps.value;
    value = value.discardChanges();
    return value;
  }

  updateIfValue(ifValue) {
    if (!ifValue) {
      this.valueChanged();
      return;
    }

    this.updateValue(this.getUpdatedValue());
  }

  updateIteratedValue(value) {
    if (this.deps.ifValue) {
      var ifValue = this.deps.ifValue;
      ifValue = ifValue.discardChanges();
      if (!ifValue) {
        this.valueChanged();
        return;
      }
    }

    this.updateValue(value);
  }

  updateValue(value) {
    if (!this.deps.hasRepeat)
      value = [value];
    var observe = this.deps.hasRepeat && Array.isArray(value);
    this.valueChanged(value, observe);
  }

  valueChanged(value, observeValue) {
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
  }

  getLastInstanceNode(index) {
    if (index == -1)
      return this.template;
    var instance = this.instances[index];
    var terminator = instance.terminator;
    if (!terminator)
      return this.getLastInstanceNode(index - 1);

    if (!(terminator instanceof Element) || this.template === terminator) {
      return terminator;
    }

    var subtemplateIterator = iterators.get(terminator);
    if (!subtemplateIterator)
      return terminator;

    return subtemplateIterator.getLastTemplateNode();
  }

  getLastTemplateNode() {
    return this.getLastInstanceNode(this.instances.length - 1);
  }

  insertInstanceAt(index, instance) {
    var previousInstanceLast = this.getLastInstanceNode(index - 1);
    var parent = this.template.parentNode;
    this.instances.splice(index, 0, instance);
    parent.insertBefore(instance.fragment, previousInstanceLast.nextSibling);
  }

  extractInstanceAt(index) {
    var previousInstanceLast = this.getLastInstanceNode(index - 1);
    var lastNode = this.getLastInstanceNode(index);
    var parent = this.template.parentNode;
    var instance = this.instances.splice(index, 1)[0];

    while (lastNode !== previousInstanceLast) {
      var node = previousInstanceLast.nextSibling;
      if (node == lastNode)
        lastNode = previousInstanceLast;

      instance.fragment.appendChild(parent.removeChild(node));
    }

    return instance;
  }

  handleSplices(splices) {
    if (this.closed || !splices.length)
      return;

    var template = this.template;

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
          if (model === undefined || model === null) {
            instance = emptyInstance;
          } else {
            instance = createInstance(this.contentTemplate, model);
          }
        }

        this.insertInstanceAt(addIndex, instance);
      }
    }

    instanceCache.forEach(function(instance) {
      instance.close();
    });
  }

  unobserve() {
    if (!this.arrayObserver)
      return;

    this.arrayObserver.close();
    this.arrayObserver = undefined;
  }

  close() {
    if (this.closed)
      return;
    this.unobserve();
    for (var i = 0; i < this.instances.length; i++) {
      this.instances[i].close();
    }

    this.instances.length = 0;
    this.closeDeps();
    iterators.delete(this.template);
    this.closed = true;
  }
}

window.TemplateIterator = TemplateIterator;

})();
