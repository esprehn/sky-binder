Element.prototype.getAttributes = function() {
  var result = [];
  var attributes = this.attributes;
  var i = 0;
  for (var attr = attributes[i]; attr; ++i)
    result.push(attr);
  return result;
};

function Document() {
  return document.implementation.createHTMLDocument();
}
