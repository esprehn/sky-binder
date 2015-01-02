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

var directiveCache = new WeakMap();

function createInstance(template, model) {
  var content = template.content;
  if (!content.firstChild)
    return emptyInstance;

  var directives = directiveCache.get(content);
  if (!directives) {
    directives = createDirectives(content);
    directiveCache.set(content, directives);
  }

  var instance = new TemplateInstance();

  var length = directives.children.length;
  for (var i = 0; i < length; ++i) {
    var clone = cloneAndBindInstance(instance.fragment,
                                     directives.children[i],
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

class BoundProperty {
  constructor(name) {
    this.name = name;
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
  bindProperty(node, model) {
    var name = this.name;
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

function parseMustaches(value, property) {
  if (!value || !value.length)
    return;

  var result;
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
    if (!result)
      result = new BoundProperty(property);
    result.expressions.push(new BindingExpression(prefix, path));
  }

  if (result && offset < value.length)
    result.suffix = value.substring(offset);

  return result;
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

class BindingDirectives {
  constructor(node) {
    this.eventHandlers = [];
    this.children = [];
    this.properties = [];
    this.node = node;
    Object.preventExtensions(this);
  }
  findProperty(name) {
    for (var i = 0; i < this.properties.length; ++i) {
      if (this.properties[i].name === name)
        return this.properties[i];
    }
    return null;
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

function parseAttributeBindings(element, directives) {
  var attributes = element.getAttributes();

  for (var i = 0; i < attributes.length; i++) {
    var attr = attributes[i];
    var name = attr.name;
    var value = attr.value;

    if (name.startsWith('on-')) {
      directives.eventHandlers.push({
        eventName: name.substring(3),
        method: value
      });
      continue;
    }

    var property = parseMustaches(value, name);
    if (!property)
      continue;

    directives.properties.push(property);
  }
}

function createDirectives(node) {
  var directives = new BindingDirectives(node);

  if (node instanceof Element) {
    parseAttributeBindings(node, directives);
  } else if (node instanceof Text) {
    var property = parseMustaches(node.data, 'textContent');
    if (property) {
      directives.properties.push(property);
    }
  }

  for (var child = node.firstChild; child; child = child.nextSibling) {
    directives.children.push(createDirectives(child));
  }

  return directives;
}

function cloneAndBindInstance(parent, directives, model, bindings) {
  var clone = parent.appendChild(directives.cloneNode());

  for (var i = 0; i < directives.children.length; ++i) {
    cloneAndBindInstance(clone,
                          directives.children[i],
                          model, bindings);
  }

  for (var i = 0; i < directives.properties.length; ++i) {
    bindings.push(directives.properties[i].bindProperty(clone, model));
  }

  if (clone instanceof HTMLTemplateElement) {
    var iterator = new TemplateIterator(clone);
    iterator.updateDependencies(directives, model);
    bindings.push(iterator);
  }

  return clone;
}

window.createInstance = createInstance;
window.emptyInstance = emptyInstance;

})();
