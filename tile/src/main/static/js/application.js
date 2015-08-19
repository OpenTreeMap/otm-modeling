var weightedOverlay, map, summary, pointControl, pointMarker;

// Los Angeles extent (xmin, ymin, xmax, ymax)
var bbox = [-1.3415009998022718E7,
            3902022.154861766,
            -1.2910049313106166E7,
            4169452.4638042958].join(",")

var defaultCenter = [34.052234, -118.243685];

var defaultZoom = 10;

var layers = [
    {name: 'Peo10_no-huc12', weight: 0},
    {name: 'Budget_Sum-huc08', weight: 0},
    {name: 'HUC_sqmi-huc12', weight: 0}
];

// Convert JSON to HTML table.
var tablify = function(json) {
    if (typeof json !== 'object') {
        return json;
    }
    var rows = [];
    for (var k in json) {
        rows.push('<td style="border:1px solid #999;padding:5px;">' + k + '</td>'
           + '<td style="border:1px solid #999;padding:5px;">' + tablify(json[k]) + '</td>');
    }
    return '<table>' + rows.join('</tr><tr>')  + '</table>';
};

var SummaryControl = L.Control.extend({
    options: {
        position: 'topright'
    },

    initialize: function(options) {
        this.json = options.json;
    },

    onAdd: function(rawMap) {
        var container = L.DomUtil.create('div', 'test-panel leaflet-bar');
        container.innerHTML = tablify(this.json);
        L.DomEvent.disableClickPropagation(container);
        return container;
    }
});

var WeightedOverlayControl = L.Control.extend({
    options: {
        position: 'topleft'
    },

    onAdd: function(rawMap) {
        var container = L.DomUtil.create('div', 'test-panel leaflet-bar');

        var update = function() {
            weightedOverlay.update();
        };

        var addLayer = function(layer) {
            var p = L.DomUtil.create('p');

            var lbl = L.DomUtil.create('label');
            lbl.innerText = layer.name + ' (' + layer.weight + ')';
            p.appendChild(lbl);

            var slider = L.DomUtil.create('input');
            slider.type = 'range';
            slider.min = -5;
            slider.max = 5;
            slider.step = 1;
            L.DomEvent.addListener(slider, 'input', function(e) {
                layer.weight = parseInt(e.target.value);
                lbl.innerText = layer.name + ' (' + layer.weight + ')';
            });
            L.DomEvent.addListener(slider, 'change', update);
            p.appendChild(slider);

            container.appendChild(p);
        };

        _.each(layers, addLayer);

        var btn = L.DomUtil.create('button');
        btn.textContent = 'Update';
        container.appendChild(btn);

        L.DomEvent.addListener(btn, 'click', function() {
            update();
        });

        L.DomEvent.disableClickPropagation(container);
        return container;
    }
});

map = (function() {
    var m = L.map('map', {
        zoomControl: false
    });

    var maskGroup = new L.FeatureGroup();

    m.setView(defaultCenter, defaultZoom);

    var baseMap = L.tileLayer(
        'http://{s}.tiles.mapbox.com/v3/azavea.map-zbompf85/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: 'Map data &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors, <a href="http://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>, Imagery &copy; <a href="http://mapbox.com">MapBox</a>'
        });

    m.on('draw:created', function(e) {
        maskGroup.addLayer(e.layer);
        weightedOverlay.update();
    });
    m.on('draw:edited', function(e) {
        weightedOverlay.update();
    });
    m.on('draw:deleted', function(e) {
        weightedOverlay.update();
    });

    m.addLayer(baseMap);
    m.addLayer(maskGroup);
    m.addControl(new WeightedOverlayControl());
    m.addControl(new L.Control.Draw({
        draw: {
            polyline: false,
            circle: false,
            marker: false,
            polygon: {
                shapeOptions: {
                    fill: false
                }
            },
            rectangle: {
                shapeOptions: {
                    fill: false
                }
            }
        },
        edit: {
            featureGroup: maskGroup
        }
    }));

    m.on('click', function(e) {
        console.log(e);
        var icon = new L.Icon.Default({
            iconUrl: '../img/leaflet/marker-icon.png',
            shadowUrl: '../img/leaflet/marker-shadow.png'
        });

        if (pointMarker) {
            m.removeControl(pointMarker);
        }
        pointMarker = new L.Marker(e.latlng, {
            icon: icon
        });
        m.addControl(pointMarker);

        var pt = e.latlng;
        var coords = ["Tree ID", pt.lng, pt.lat].join(",");

        $.ajax({
            url: 'gt/value',
            type: 'POST',
            data: {
                bbox: bbox,
                layer: layers[0].name,
                coords: coords
            },
            dataType: 'json',
            success: function(data) {
                if (pointControl) {
                    m.removeControl(pointControl);
                    pointControl = null;
                }
                pointControl = new SummaryControl({ json: data });
                m.addControl(pointControl);
            }
        });
    });

    return {
        getMaskGeoJSON: function() {
            return maskGroup.toGeoJSON();
        },
        getRawMap: function() {
            return m;
        }
    };
})();

weightedOverlay = (function() {
    var layersToWeights = {}
    var breaks = null;
    var WOLayer = null;
    var opacity = 0.5;
    var colorRamp = "blue-to-red";
    var numBreaks = 10;

    var getLayers = function() {
        return _.map(layers, function(l) { return l.name; }).join(",");
    };

    var getWeights = function() {
        return _.map(layers, function(l) { return l.weight; }).join(",");
    };

    var update = function() {
        var layerNames = getLayers();
        if (layerNames == "") {
            return;
        }

        if (WOLayer) {
            map.getRawMap().removeLayer(WOLayer);
        }
        if (summary) {
            map.getRawMap().removeControl(summary);
            summary = null;
        }

        var geoJson = JSON.stringify(map.getMaskGeoJSON());

        $.ajax({
            url: 'gt/breaks',
            type: 'POST',
            data: {
                bbox: bbox,
                layers: getLayers(),
                weights: getWeights(),
                numBreaks: numBreaks,
                polyMask:geoJson
            },
            dataType: "json",
            success: function(r) {
                breaks = r.classBreaks;

                WOLayer = new L.TileLayer.WMS("gt/wo", {
                    layers: 'default',
                    format: 'image/png',
                    breaks: breaks,
                    transparent: true,
                    layers: layerNames,
                    weights: getWeights(),
                    colorRamp: colorRamp,
                    polyMask: geoJson,
                    attribution: 'Azavea'
                });

                WOLayer.setOpacity(opacity);
                map.getRawMap().addLayer(WOLayer, "Weighted Overlay");
            }
        });

        $.ajax({
            url: 'gt/histogram',
            type: 'POST',
            data: {
                bbox: bbox,
                layer: layers[0].name,
                polyMask: geoJson
            },
            dataType: "json",
            success: function(data) {
                summary = new SummaryControl({ json: data });
                map.getRawMap().addControl(summary);
            }
        });
    };

    return {
        update: update
    };
})();

