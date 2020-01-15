/* global fetch */

import {COORDINATE_SYSTEM, CompositeLayer} from '@deck.gl/core';
import {PointCloudLayer} from '@deck.gl/layers';
import {ScenegraphLayer} from '@deck.gl/mesh-layers';
import {log} from '@deck.gl/core';

import {Tileset3D, _getIonTilesetMetadata} from '@loaders.gl/3d-tiles';

const defaultProps = {
  getPointColor: [0, 0, 0],
  pointSize: 1.0,

  data: null,
  loader: TilesetLoader,
  _ionAssetId: null,
  _ionAccessToken: null,
  loadOptions: {throttleRequests: true},

  onTilesetLoad: tileset3d => {},
  onTileLoad: tileHeader => {},
  onTileUnload: tileHeader => {},
  onTileError: (tile, message, url) => {}
};

export default class Tile3DLayer extends CompositeLayer {
  initializeState() {
    if ('onTileLoadFail' in this.props) {
      log.removed('onTileLoadFail', 'onTileError')();
    }
    this.state = {
      layerMap: {},
      tileset3d: null
    };
  }

  shouldUpdateState({changeFlags}) {
    return changeFlags.somethingChanged;
  }

  // async _loadTilesetFromIon(ionAccessToken, ionAssetId) {
  //   const ionMetadata = await _getIonTilesetMetadata(ionAccessToken, ionAssetId);
  //   const {url, headers} = ionMetadata;
  //   await this._loadTileset(url, {headers}, ionMetadata);
  // }

  updateState({props, oldProps, changeFlags}) {
    if (props.data && props.data !== oldProps.data) {
      this._loadTileset(props.data);
    } else if (
      (props._ionAccessToken || props._ionAssetId) &&
      (props._ionAccessToken !== oldProps._ionAccessToken ||
        props._ionAssetId !== oldProps._ionAssetId)
    ) {
      this._loadTilesetFromIon(props._ionAccessToken, props._ionAssetId);
    }

    if (changeFlags.viewportChanged) {
      const {tileset3d} = this.state;
      this._updateTileset(tileset3d);
    }
  }

  async _loadTileset(tilesetUrl, fetchOptions, ionMetadata) {
    // loader: IonLoader, Tile3DLoader, I3SLoader
    // output: Tilset3D object
    const tileset3d = load(tilesetUrl, loader, options);

    this.setState({
      tileset3d,
      layerMap: {}
    });

    if (tileset3d) {
      this._updateTileset(tileset3d);
      this.props.onTilesetLoad(tileset3d);
    }
  }

  _updateTileset(tileset3d) {
    // what is timeline?
    const {timeline, viewport} = this.context;
    if (!timeline || !viewport || !tileset3d) {
      return;
    }

    const frameNumber = tileset3d.update(viewport);
    this._updateLayerMap(frameNumber);
  }

  // `Layer` instances is created and added to the map if it doesn't exist yet.
  _updateLayerMap(frameNumber) {
    const {tileset3d, layerMap} = this.state;

    // create layers for new tiles
    const {selectedTiles} = tileset3d;
    const tilesWithoutLayer = selectedTiles.filter(tile => !layerMap[tile.id]);

    for (const tile of tilesWithoutLayer) {
      // TODO - why do we call this here? Being "selected" should automatically add it to cache?
      tileset3d.addTileToCache(tile);

      layerMap[tile.id] = {
        layer: this._create3DTileLayer(tile),
        tile
      };
    }

    // update layer visibility
    this._selectLayers(frameNumber);
  }

  // Grab only those layers who were selected this frame.
  _selectLayers(frameNumber) {
    const {layerMap} = this.state;
    const layerMapValues = Object.values(layerMap);

    for (const value of layerMapValues) {
      const {tile} = value;
      let {layer} = value;

      if (tile.selectedFrame === frameNumber) {
        if (layer && layer.props && !layer.props.visible) {
          // Still has GPU resource but visibility is turned off so turn it back on so we can render it.
          layer = layer.clone({visible: true});
          layerMap[tile.id].layer = layer;
        }
      } else if (tile.contentUnloaded) {
        // Was cleaned up from tileset cache. We no longer need to track it.
        delete layerMap[tile.id];
      } else if (layer && layer.props && layer.props.visible) {
        // Still in tileset cache but doesn't need to render this frame. Keep the GPU resource bound but don't render it.
        layer = layer.clone({visible: false});
        layerMap[tile.id].layer = layer;
      }
    }

    this.setState({layers: Object.values(layerMap).map(layer => layer.layer)});
  }

  _create3DTileLayer(tileHeader) {
    if (!tileHeader.layerType) {
      return null;
    }

    switch (tileHeader.layerType) {
    case 'pointcloud':
      return this._createPointCloudTileLayer(tileHeader);
    case 'scenegraph':
      return this._create3DModelTileLayer(tileHeader);
    case 'simplemesh':
      return this._createSimpleMeshLayer(tileHeader);
    default:
      throw new Error(`Tile3DLayer: Failed to render layer of type ${tileHeader.content.type}`);
    }
  }

  // - id
  // - renderState
  //   - selected
  //   - unloaded
  // - content
  //   -

  _create3DModelTileLayer(tileHeader) {
    // const {gltf, instances, modelMatrix, cartographicOrigin} = tileHeader.content;
    // const {attributes, pointCount, constantRGBA, modelMatrix, cartographicOrigin} = tileHeader.content;
    // const {attributes, texture, modelMatrix, cartographicOrigin} = tileHeader.content;

    // tileHeader
    // layer specific
    // - layerProps

    const SubLayerClass = this.getSubLayerClass('scenegraph', ScenegraphLayer);

    return new SubLayerClass(
      {
        _lighting: 'pbr'
      },
      this.getSubLayerProps({
        id: 'scenegraph'
      }),
      {
        id: `${this.id}-scenegraph-${tileHeader.id}`,
        // Fix for ScenegraphLayer.modelMatrix, under flag in deck 7.3 to avoid breaking existing code
        data: instances || [{}],
        scenegraph: gltf,

        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: cartographicOrigin,
        modelMatrix,
        getTransformMatrix: instance => instance.modelMatrix,
        getPosition: instance => [0, 0, 0]
      }
    );
  }

  _createPointCloudTileLayer(tileHeader) {
    const {
      attributes,
      pointCount,
      constantRGBA,
      cartographicOrigin,
      modelMatrix
    } = tileHeader.content;
    const {positions, normals, colors} = attributes;

    if (!positions) {
      return null;
    }

    const {pointSize, getPointColor} = this.props;
    const SubLayerClass = this.getSubLayerClass('pointcloud', PointCloudLayer);

    return new SubLayerClass(
      {
        pointSize
      },
      this.getSubLayerProps({
        id: 'pointcloud'
      }),
      {
        id: `${this.id}-pointcloud-${tileHeader.id}`,
        data: {
          header: {
            vertexCount: pointCount
          },
          attributes: {
            POSITION: positions,
            NORMAL: normals,
            COLOR_0: colors
          }
        },
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: cartographicOrigin,
        modelMatrix,

        getColor: constantRGBA || getPointColor
      }
    );
  }

  renderLayers() {
    return this.state.layers;
  }
}

Tile3DLayer.layerName = 'Tile3DLayer';
Tile3DLayer.defaultProps = defaultProps;
