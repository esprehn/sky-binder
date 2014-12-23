"use strict";

function sanitizeValue(value) {
  return value == null ? '' : value;
}

function updateText(node, value) {
  node.data = sanitizeValue(value);
}

function updateAttribute(element, name, value) {
  element.setAttribute(name, sanitizeValue(value));
}

function bindNode(node, name, observable, oneTime) {
  if (node instanceof Text) {
    if (oneTime)
      return updateText(node, observable);
    updateText(node, observable.open(function(value) {
      return updateText(node, value);
    }));
    return observable;
  }

  if (name == 'style' || name == 'class') {
    if (oneTime)
        return updateAttribute(node, name, observable);
    updateAttribute(node, name, observable.open(function(value) {
      updateAttribute(node, name, value);
    }));
    return observable;
  }

  if (oneTime) {
    node[name] = observable;
    return;
  }

  node[name] = observable.open(function(value) {
    node[name] = value;
  });

  return observable;
};

var BIND = 'bind';
var REPEAT = 'repeat';
var IF = 'if';

var stagingDocument = new Document();

function createInstance(template, model) {
  var content = template.content;
  if (!content.firstChild)
    content = template.instanceRef_;
  if (!content.firstChild)
    return emptyInstance;

  var map = getInstanceBindingMap(content);
  var instance = stagingDocument.createDocumentFragment();

  instance.bindings_ = [];
  instance.terminator_ = null;

  var i = 0;
  var collectTerminator = false;
  for (var child = content.firstChild; child; child = child.nextSibling) {
    // The terminator of the instance is the clone of the last child of the
    // content. If the last child is an active template, it may produce
    // instances as a result of production, so simply collecting the last
    // child of the instance after it has finished producing may be wrong.
    if (child.nextSibling === null)
      collectTerminator = true;

    var clone = cloneAndBindInstance(instance, stagingDocument,
                                     map.children[i++],
                                     model,
                                     instance.bindings_);
    if (collectTerminator)
      instance.terminator_ = clone;
  }

  return instance;
}

// Returns
//   a) undefined if there are no mustaches.
//   b) [TEXT, (ONE_TIME?, PATH, DELEGATE_FN, TEXT)+] if there is at least
//      one mustache.
function parseMustaches(s) {
  if (!s || !s.length)
    return;

  var tokens;
  var length = s.length;
  var startIndex = 0, lastIndex = 0, endIndex = 0;
  var onlyOneTime = true;
  while (lastIndex < length) {
    var startIndex = s.indexOf('{{', lastIndex);
    var oneTimeStart = s.indexOf('[[', lastIndex);
    var oneTime = false;
    var terminator = '}}';

    if (oneTimeStart >= 0 &&
        (startIndex < 0 || oneTimeStart < startIndex)) {
      startIndex = oneTimeStart;
      oneTime = true;
      terminator = ']]';
    }

    endIndex = startIndex < 0 ? -1 : s.indexOf(terminator, startIndex + 2);

    if (endIndex < 0) {
      if (!tokens)
        return;

      tokens.push(s.slice(lastIndex)); // TEXT
      break;
    }

    tokens = tokens || [];
    tokens.push(s.slice(lastIndex, startIndex)); // TEXT
    var pathString = s.slice(startIndex + 2, endIndex).trim();
    tokens.push(oneTime); // ONE_TIME?
    onlyOneTime = onlyOneTime && oneTime;
    tokens.push(observe.Path.get(pathString)); // PATH
    tokens.push(null); // DELEGATE_FN
    lastIndex = endIndex + 2;
  }

  if (lastIndex === length)
    tokens.push(''); // TEXT

  tokens.hasOnePath = tokens.length === 5;
  tokens.isSimplePath = tokens.hasOnePath &&
                        tokens[0] == '' &&
                        tokens[4] == '';
  tokens.onlyOneTime = onlyOneTime;

  tokens.combinator = function(values) {
    var newValue = tokens[0];

    for (var i = 1; i < tokens.length; i += 4) {
      var value = tokens.hasOnePath ? values : values[(i - 1) / 4];
      if (value !== undefined)
        newValue += value;
      newValue += tokens[i + 3];
    }

    return newValue;
  }

  return tokens;
};

function processOneTimeBinding(name, tokens, node, model) {
  if (tokens.hasOnePath) {
    var value = tokens[2].getValueFrom(model);
    return tokens.isSimplePath ? value : tokens.combinator(value);
  }

  var values = [];
  for (var i = 1; i < tokens.length; i += 4) {
    values[(i - 1) / 4] = tokens[i + 1].getValueFrom(model);
  }

  return tokens.combinator(values);
}

function processSinglePathBinding(name, tokens, node, model) {
  var observer = new observe.PathObserver(model, tokens[2]);
  return tokens.isSimplePath ? observer :
      new observe.ObserverTransform(observer, tokens.combinator);
}

function processBinding(name, tokens, node, model) {
  if (tokens.onlyOneTime)
    return processOneTimeBinding(name, tokens, node, model);

  if (tokens.hasOnePath)
    return processSinglePathBinding(name, tokens, node, model);

  var observer = new observe.CompoundObserver();

  for (var i = 1; i < tokens.length; i += 4) {
    var oneTime = tokens[i];
    var path = tokens[i + 1];
    if (oneTime)
      observer.addPath(path.getValueFrom(model))
    else
      observer.addPath(model, path);
  }

  return new observe.ObserverTransform(observer, tokens.combinator);
}

function processBindings(node, bindings, model, instanceBindings) {
  for (var i = 0; i < bindings.properties.length; i += 2) {
    var name = bindings.properties[i].name;
    var tokens = bindings.properties[i].tokens;
    var value = processBinding(name, tokens, node, model);
    var binding = bindNode(node, name, value, tokens.onlyOneTime);
    if (binding && instanceBindings)
      instanceBindings.push(binding);
  }

  if (node instanceof HTMLTemplateElement) {
    var iter = processTemplateBindings(node, bindings, model);
    if (instanceBindings && iter)
      instanceBindings.push(iter);
  }
}

function processTemplateBindings(template, directives, model) {
  if (template.iterator_)
    template.iterator_.closeDeps();

  if (!directives.if && !directives.bind && !directives.repeat) {
    if (template.iterator_) {
      template.iterator_.close();
      template.iterator_ = undefined;
    }

    return;
  }

  if (!template.iterator_) {
    template.iterator_ = new TemplateIterator(template);
  }

  template.iterator_.updateDependencies(directives, model);

  return template.iterator_;
};

function parseWithDefault(value) {
  return parseMustaches(value == '' ? '{{}}' : value);
}

function addEventHandler(element, name, method) {
  element.addEventListener(name, function(event) {
    var scope = element.ownerScope;
    var host = scope.host;
    var handler = host && host[method];
    if (handler instanceof Function)
      return handler.call(host, event);
  });
}

class Bindings {
  constructor(node) {
    this.if = false;
    this.bind = false;
    this.repeat = false;
    this.eventHandlers = null;
    this.children = [];
    this.properties = [];
    this.node = node;
    Object.preventExtensions(this);
  }

  cloneNode() {
    // TODO(esprehn): In sky instead of needing to use a staging docuemnt per
    // custom element registry we're going to need to use the current module's
    // registry.
    return stagingDocument.importNode(this.node, false);
  }
}

function parseAttributeBindings(element, bindings) {
  var attributes = element.getAttributes();

  for (var i = 0; i < attributes.length; i++) {
    var attr = attributes[i];
    var name = attr.name;
    var value = attr.value;

    if (element instanceof HTMLTemplateElement) {
      if (name == IF) {
        bindings.if = parseWithDefault(value);
        continue;
      } else if (name == BIND) {
        bindings.bind = parseWithDefault(value);
        continue;
      } else if (name == REPEAT) {
        bindings.repeat = parseWithDefault(value);
        continue;
      }
    }

    if (name.startsWith('on-')) {
      if (!bindings.eventHandlers)
        bindings.eventHandlers = new Map();
      bindings.eventHandlers.set(name.substring(3), value);
      continue;
    }

    var tokens = parseMustaches(value);
    if (!tokens)
      continue;

    bindings.properties.push({
      name: name,
      tokens: tokens,
    });
  }

  if (bindings.if && !bindings.bind && !bindings.repeat)
    bindings.bind = parseMustaches('{{}}');
}

function getBindings(node) {
  var bindings = new Bindings(node);

  if (node instanceof Element) {
    parseAttributeBindings(node, bindings);
  } else if (node instanceof Text) {
    var tokens = parseMustaches(node.data);
    if (tokens) {
      bindings.properties.push({
        name: 'textContent',
        tokens: tokens,
      });
    }
  }

  return bindings;
}

function cloneAndBindInstance(parent, stagingDocument, bindings, model, instanceBindings) {
  var clone = parent.appendChild(bindings.cloneNode());

  for (var i = 0; i < bindings.children.length; ++i) {
    cloneAndBindInstance(clone, stagingDocument,
                          bindings.children[i],
                          model, instanceBindings);
  }

  if (clone instanceof HTMLTemplateElement) {
    clone.instanceRef_ = bindings.node.content;
  }

  if (bindings.eventHandlers) {
    bindings.eventHandlers.forEach(function(handler, eventName) {
      addEventHandler(clone, eventName, handler);
    });
  }

  processBindings(clone, bindings, model, instanceBindings);
  return clone;
}

function createInstanceBindingMap(node) {
  var map = getBindings(node);
  for (var child = node.firstChild; child; child = child.nextSibling) {
    map.children.push(createInstanceBindingMap(child));
  }
  return map;
}

function getInstanceBindingMap(content) {
  var map = content.bindingMap_;
  if (!map) {
    map = content.bindingMap_ = createInstanceBindingMap(content);
  }
  return map;
}

var emptyInstance = document.createDocumentFragment();
emptyInstance.bindings_ = [];
emptyInstance.terminator_ = null;

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
      deps.ifValue = processBinding(IF, directives.if, template, model);

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
      deps.value = processBinding(REPEAT, directives.repeat, template, model);
    } else {
      deps.repeat = false;
      deps.oneTime = directives.bind.onlyOneTime;
      deps.value = processBinding(BIND, directives.bind, template, model);
    }

    var value = deps.value;
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

    if (terminator.nodeType !== Node.ELEMENT_NODE ||
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
