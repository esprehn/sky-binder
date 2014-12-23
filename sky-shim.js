(function() {

Object.defineProperty(Node.prototype, 'ownerScope', {
    get: function() {
        var node = this;
        while (node.parentNode)
            node = node.parentNode;
        if (node instanceof ShadowRoot || node instanceof Document)
            return node;
        return null;
    },
});

Element.prototype.getAttributes = function() {
  var result = [];
  var attributes = this.attributes;
  var i = 0;
  for (var attr = attributes[i]; attr; attr = attributes[++i])
    result.push(attr);
  return result;
};

function Document() {
  return document.implementation.createHTMLDocument();
}

Document.prototype = window.Document.prototype;
Document.__proto__ = window.Document;
window.Document = Document;

})();