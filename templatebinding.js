"use strict";
(function() {

var stagingDocument = new Document();

class TemplateInstance {
  constructor() {
    this.bindings = [];
    this.terminator = null;
    this.fragment = stagingDocument.createDocumentFragment();
    Object.preventExtensions(this);
  }
  close() {
    var bindings = this.bindings;
    for (var i = 0; i < bindings.length; i++) {
      bindings[i].close();
    }
  }
}

var emptyInstance = new TemplateInstance();

function sanitizeValue(value) {
  return value == null ? '' : value;
}

function updateText(node, value) {
  node.data = sanitizeValue(value);
}

function updateAttribute(element, name, value) {
  element.setAttribute(name, sanitizeValue(value));
}

var bindingCache = new WeakMap();

function createInstance(template, model) {
  var content = template.content;
  if (!content.firstChild)
    return emptyInstance;

  var bindings = bindingCache.get(content);
  if (!bindings) {
    bindings = createBindings(content);
    bindingCache.set(content, bindings);
  }

  var instance = new TemplateInstance();

  var length = bindings.children.length;
  for (var i = 0; i < length; ++i) {
    var clone = cloneAndBindInstance(instance.fragment,
                                     bindings.children[i],
                                     model,
                                     instance.bindings);

    // The terminator of the instance is the clone of the last child of the
    // content. If the last child is an active template, it may produce
    // instances as a result of production, so simply collecting the last
    // child of the instance after it has finished producing may be wrong.
    if (i == length - 1)
      instance.terminator = clone;
  }

  return instance;
}

class BindingExpression {
  constructor(prefix, path) {
    this.prefix = prefix;
    this.path = observe.Path.get(path);
    Object.preventExtensions(this);
  }
}

class BindingExpressionList {
  constructor() {
    this.expressions = [];
    this.suffix = "";
    Object.preventExtensions(this);
  }
  createObserver(model) {
    var expressions = this.expressions;
    var suffix = this.suffix;

    if (expressions.length == 1 && expressions[0].prefix == "" && suffix == "")
      return new observe.PathObserver(model, expressions[0].path);

    var observer = new observe.CompoundObserver();

    for (var i = 0; i < expressions.length; ++i)
      observer.addPath(model, expressions[i].path);

    return new observe.ObserverTransform(observer, function(values) {
      var buffer = "";
      for (var i = 0; i < values.length; ++i) {
        buffer += expressions[i].prefix;
        buffer += values[i];
      }
      buffer += suffix;
      return buffer;
    });
  }
  bindProperty(node, name, model) {
    var observable = this.createObserver(model);
    if (node instanceof Text) {
      updateText(node, observable.open(function(value) {
        return updateText(node, value);
      }));
    } else if (name == 'style' || name == 'class') {
      updateAttribute(node, name, observable.open(function(value) {
        updateAttribute(node, name, value);
      }));
    } else {
      node[name] = observable.open(function(value) {
        node[name] = value;
      });
    }
    return observable;
  }
}

function parseMustaches(value) {
  if (!value || !value.length)
    return;

  var list;
  var offset = 0;
  var firstIndex = 0;
  var lastIndex = 0;

  while (offset < value.length) {
    firstIndex = value.indexOf('{{', offset);
    if (firstIndex == -1)
      break;
    lastIndex = value.indexOf('}}', firstIndex + 2);
    if (lastIndex == -1)
      lastIndex = value.length;
    var prefix = value.substring(offset, firstIndex);
    var path = value.substring(firstIndex + 2, lastIndex);
    offset = lastIndex + 2;
    if (!list)
      list = new BindingExpressionList();
    list.expressions.push(new BindingExpression(prefix, path));
  }

  if (list && offset < value.length)
    list.suffix = value.substring(offset);

  return list;
};

function addEventHandler(element, name, method) {
  element.addEventListener(name, function(event) {
    var scope = element.ownerScope;
    var host = scope.host;
    var handler = host && host[method];
    if (handler instanceof Function)
      return handler.call(host, event);
  });
}

class Binding {
  constructor(node) {
    this.if = false;
    this.repeat = false;
    this.eventHandlers = [];
    this.children = [];
    this.properties = [];
    this.node = node;
    Object.preventExtensions(this);
  }

  cloneNode() {
    // TODO(esprehn): In sky instead of needing to use a staging docuemnt per
    // custom element registry we're going to need to use the current module's
    // registry.
    var clone = stagingDocument.importNode(this.node, false);

    this.eventHandlers.forEach(function(handler) {
      addEventHandler(clone, handler.eventName, handler.method);
    });

    return clone;
  }
}

function parseAttributeBindings(element, binding) {
  var attributes = element.getAttributes();

  for (var i = 0; i < attributes.length; i++) {
    var attr = attributes[i];
    var name = attr.name;
    var value = attr.value;

    if (element instanceof HTMLTemplateElement) {
      if (name == 'if') {
        binding.if = parseMustaches(value);
        continue;
      } else if (name == 'repeat') {
        binding.repeat = parseMustaches(value);
        continue;
      }
    }

    if (name.startsWith('on-')) {
      binding.eventHandlers.push({
        eventName: name.substring(3),
        method: value
      });
      continue;
    }

    var expressions = parseMustaches(value);
    if (!expressions)
      continue;

    binding.properties.push({
      name: name,
      expressions: expressions,
    });
  }
}

function createBindings(node) {
  var binding = new Binding(node);

  if (node instanceof Element) {
    parseAttributeBindings(node, binding);
  } else if (node instanceof Text) {
    var expressions = parseMustaches(node.data);
    if (expressions) {
      binding.properties.push({
        name: 'textContent',
        expressions: expressions,
      });
    }
  }

  for (var child = node.firstChild; child; child = child.nextSibling) {
    binding.children.push(createBindings(child));
  }

  return binding;
}

function cloneAndBindInstance(parent, bindings, model, instanceBindings) {
  var clone = parent.appendChild(bindings.cloneNode());

  for (var i = 0; i < bindings.children.length; ++i) {
    cloneAndBindInstance(clone,
                          bindings.children[i],
                          model, instanceBindings);
  }

  for (var i = 0; i < bindings.properties.length; ++i) {
    var name = bindings.properties[i].name;
    var expressions = bindings.properties[i].expressions;
    var observer = expressions.bindProperty(clone, name, model);
    instanceBindings.push(observer);
  }

  if (clone instanceof HTMLTemplateElement) {
    var iterator = new TemplateIterator(clone);
    iterator.updateDependencies(bindings, model);
    instanceBindings.push(iterator);
  }

  return clone;
}

window.createInstance = createInstance;
window.emptyInstance = emptyInstance;

})();
