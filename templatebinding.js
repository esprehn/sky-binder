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

  var map = content.bindingMap_;
  if (!map) {
    map = content.bindingMap_ = createBindings(content);
  }

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

    var clone = cloneAndBindInstance(instance,
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

class Binding {
  constructor(node) {
    this.if = false;
    this.bind = false;
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
    return stagingDocument.importNode(this.node, false);
  }
}

function parseAttributeBindings(element, binding) {
  var attributes = element.getAttributes();

  for (var i = 0; i < attributes.length; i++) {
    var attr = attributes[i];
    var name = attr.name;
    var value = attr.value;

    if (element instanceof HTMLTemplateElement) {
      if (name == IF) {
        binding.if = parseWithDefault(value);
        continue;
      } else if (name == BIND) {
        binding.bind = parseWithDefault(value);
        continue;
      } else if (name == REPEAT) {
        binding.repeat = parseWithDefault(value);
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

    var tokens = parseMustaches(value);
    if (!tokens)
      continue;

    binding.properties.push({
      name: name,
      tokens: tokens,
    });
  }

  if (binding.if && !binding.bind && !binding.repeat)
    binding.bind = parseMustaches('{{}}');
}

function createBindings(node) {
  var binding = new Binding(node);

  if (node instanceof Element) {
    parseAttributeBindings(node, binding);
  } else if (node instanceof Text) {
    var tokens = parseMustaches(node.data);
    if (tokens) {
      binding.properties.push({
        name: 'textContent',
        tokens: tokens,
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

  if (clone instanceof HTMLTemplateElement) {
    clone.instanceRef_ = bindings.node.content;
  }

  for (var i = 0; i < bindings.eventHandlers.length; ++i) {
    var handler = bindings.eventHandlers[i];
    addEventHandler(clone, handler.eventName, handler.method);
  }

  processBindings(clone, bindings, model, instanceBindings);
  return clone;
}

var emptyInstance = document.createDocumentFragment();
emptyInstance.bindings_ = [];
emptyInstance.terminator_ = null;
