"use strict";
(function() {

var iterators = new WeakMap();

class TemplateIterator {
  constructor(element) {
    this.closed = false;
    this.template = element;
    this.contentTemplate = null;
    this.instances = [];
    this.hasRepeat = false;
    this.ifObserver = null;
    this.valueObserver = null;
    this.iteratedValue = [];
    this.presentValue = null;
    this.arrayObserver = null;
    Object.preventExtensions(this);
    iterators.set(element, this);
  }

  updateDependencies(directives, model) {
    this.contentTemplate = directives.node;

    var ifValue = true;
    var ifProperty = directives.findProperty('if');
    if (ifProperty) {
      this.ifObserver = ifProperty.createObserver(model);
      ifValue = this.ifObserver.open(this.updateIfValue, this);
    }

    var repeatProperty = directives.findProperty('repeat');
    if (repeatProperty) {
      this.hasRepeat = true;
      this.valueObserver = repeatProperty.createObserver(model);
    } else {
      var path = observe.Path.get("");
      this.valueObserver = new observe.PathObserver(model, path);
    }

    var value = this.valueObserver.open(this.updateIteratedValue, this);
    this.updateValue(ifValue ? value : null);
  }

  getUpdatedValue() {
    return this.valueObserver.discardChanges();
  }

  updateIfValue(ifValue) {
    if (!ifValue) {
      this.valueChanged();
      return;
    }

    this.updateValue(this.getUpdatedValue());
  }

  updateIteratedValue(value) {
    if (this.ifObserver) {
      var ifValue = this.ifObserver.discardChanges();
      if (!ifValue) {
        this.valueChanged();
        return;
      }
    }

    this.updateValue(value);
  }

  updateValue(value) {
    if (!this.hasRepeat)
      value = [value];
    var observe = this.hasRepeat && Array.isArray(value);
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
    this.arrayObserver = null;
  }

  close() {
    if (this.closed)
      return;
    this.unobserve();
    for (var i = 0; i < this.instances.length; i++) {
      this.instances[i].close();
    }

    this.instances.length = 0;

    if (this.ifBinding)
      this.ifBinding.close();
    if (this.binding)
      this.binding.close();

    iterators.delete(this.template);
    this.closed = true;
  }
}

window.TemplateIterator = TemplateIterator;

})();
