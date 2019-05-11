import {Matrix4} from 'math.gl';
import assert from '../utils/assert';
import Tile3DHeader from './tile-3d-header';
import Tileset3DCache from './tileset-3d-cache';

const Ellipsoid = {
  WGS84: ''
};

const DEFAULT_OPTIONS = {
  basePath: '',

  ellipsoid: Ellipsoid.WGS84,

  cullWithChildrenBounds: true,
  maximumScreenSpaceError: 16,
  maximumMemoryUsage: 512,

  modelMatrix: new Matrix4(),

  // default props
  dynamicScreenSpaceError: false,
  dynamicScreenSpaceErrorDensity: 0.00278,
  dynamicScreenSpaceErrorFactor: 4.0,
  dynamicScreenSpaceErrorHeightFalloff: 0.25,

  // Optimization option. Determines if level of detail skipping should be applied during the traversal.
  skipLevelOfDetail: true,
  // The screen space error this must be reached before skipping levels of detail.
  baseScreenSpaceError: 1024,
  // Multiplier defining the minimum screen space error to skip.
  skipScreenSpaceErrorFactor: 16,
  // Constant defining the minimum number of levels to skip when loading tiles. When it is 0, no levels are skipped.
  skipLevels: 1,
  // When true, only tiles this meet the maximum screen space error will ever be downloaded.
  immediatelyLoadDesiredLevelOfDetail: false,
  // Determines whether siblings of visible tiles are always downloaded during traversal.
  loadSiblings: false,

  onLoadProgress: () => {}, // Indicates progress of loading new tiles
  onAllTilesLoaded: () => {}, // All tiles that meet the screen space error of this frame are loaded
  initialTilesLoaded: () => {}, // Indicates all tiles meet the screen space error this frame loaded
  onTileLoad: () => {}, // Indicates this a tile's content was loaded
  onTileUnload: () => {}, // Indicates this a tile's content was unloaded
  onTileLoadFailed: ({tile, message, url}) => {
    // Indicates this a tile's content failed to load
    console.error(`A 3D tile failed to load: ${url} ${message}`); // eslint-disable-line
  },
  onTileVisible: () => {} // Called once for each visible tile in a frame. E.g manual styling
};

export default class Tileset3D {
  // eslint-disable-next-line max-statements
  constructor(json, url, options = {}) {
    options = {...DEFAULT_OPTIONS, ...options};

    // const {cullWithChildrenBounds, maximumScreenSpaceError, maximumMemoryUsage} = options;
    const {cullWithChildrenBounds} = options;

    assert(json);

    this._url = undefined;
    this._basePath = undefined;
    this._root = undefined;

    this._asset = undefined; // Metadata for the entire tileset
    this._properties = undefined; // Metadata for per-model/point/etc properties
    this._geometricError = undefined; // Geometric error when the tree is not rendered at all
    this._extensionsUsed = undefined;
    this._gltfUpAxis = undefined;

    this._cache = new Tileset3DCache();
    this._processingQueue = [];
    this._selectedTiles = [];
    this._emptyTiles = [];
    this._requestedTiles = [];
    this._selectedTilesToStyle = [];
    this._loadTimestamp = undefined;
    this._timeSinceLoad = 0.0;
    this._updatedVisibilityFrame = 0;
    this._extras = undefined;
    this._credits = undefined;

    this._cullWithChildrenBounds = cullWithChildrenBounds;
    this._allTilesAdditive = true;

    this._hasMixedContent = false;

    this._maximumScreenSpaceError = options.maximumScreenSpaceError;
    this._maximumMemoryUsage = options.maximumMemoryUsage;

    this._modelMatrix = options.modelMatrix;

    this._tilesLoaded = false;
    this._initialTilesLoaded = false;

    this._readyPromise = new Promise();

    this._classificationType = options.classificationType;
    this._ellipsoid = options.ellipsoid;

    this._dynamicScreenSpaceErrorComputedDensity = 0.0; // Updated based on the camera position and direction
    this._skipLevelOfDetail = this.skipLevelOfDetail;
    this._disableSkipLevelOfDetail = false;

    this.onLoadProgress = options.onLoadProgress;
    this.onAllTilesLoaded = options.onAllTilesLoaded;
    this.initialTilesLoaded = options.initialTilesLoaded;
    this.onTileLoad = options.onTileLoad;
    this.onTileUnload = options.onTileUnload;
    this.onTileLoadFailed = options.onTileLoadFailed;
    this.onTileVisible = options.onTileVisible;

    // Optimization option. Determines if level of detail skipping should be applied during the traversal.
    this._skipLevelOfDetail = this.skipLevelOfDetail;
    this._disableSkipLevelOfDetail = false;

    this.initializeTileSet(json, options);

    this.props = {};
    Object.assign(this.props, options);
  }

  destroy() {
    // Traverse the tree and destroy all tiles
    const stack = [];

    if (this._root) {
      stack.push(this._root);
    }

    while (stack.length > 0) {
      for (const child of tile.children) {
        stack.push(child);
      }
      const tile = stack.pop();
      tile.destroy();
    }

    this._root = null;
  }

  // eslint-disable-next-line max-statements
  initializeTileSet(tilesetJson, options) {
    // ion resources have a credits property we can use for additional attribution.
    // this._credits = resource.credits;

    this._url = options.url;
    this._basePath = options.basePath || '';

    // this._root = this.loadTileset(resource, tilesetJson);
    // const gltfUpAxis = defined(tilesetJson.asset.gltfUpAxis)
    //   ? Axis.fromName(tilesetJson.asset.gltfUpAxis)
    //   : Axis.Y;
    const asset = tilesetJson.asset;
    this._asset = asset;
    this._properties = tilesetJson.properties;
    this._geometricError = tilesetJson.geometricError;
    this._extensionsUsed = tilesetJson.extensionsUsed;
    // this._gltfUpAxis = gltfUpAxis;
    this._extras = tilesetJson.extras;

    this._credits = this._getCredits();

    // Save the original, untransformed bounding volume position so we can apply
    // the tile transform and model matrix at run time
    // const boundingVolume = this._root.createBoundingVolume(
    //   tilesetJson.root.boundingVolume,
    //   Matrix4.IDENTITY
    // );
    // const clippingPlanesOrigin = boundingVolume.boundingSphere.center;
    // If this origin is above the surface of the earth
    // we want to apply an ENU orientation as our best guess of orientation.
    // Otherwise, we assume it gets its position/orientation completely from the
    // root tile transform and the tileset's model matrix
    // const originCartographic = this._ellipsoid.cartesianToCartographic(clippingPlanesOrigin);
    // if (
    //   originCartographic &&
    //   originCartographic.height > ApproximateTerrainHeights._defaultMinTerrainHeight
    // ) {
    //   this._initialClippingPlanesOriginMatrix = Transforms.eastNorthUpToFixedFrame(
    //     clippingPlanesOrigin
    //   );
    // }

    this._clippingPlanesOriginMatrix = Matrix4.clone(this._initialClippingPlanesOriginMatrix);
    this._readyPromise.resolve(this);
  }

  // Gets the tileset's asset object property, which contains metadata about the tileset.
  get asset() {
    return this._asset;
  }

  // Gets the tileset's properties dictionary object, which contains metadata about per-feature properties.
  get properties() {
    return this._properties;
  }

  // When <code>true</code>, the tileset's root tile is loaded and the tileset is ready to render.
  get ready() {
    return Boolean(this._root);
  }

  // Gets the promise this will be resolved when the tileset's root tile is loaded and the tileset is ready to render.
  // This promise is resolved at the end of the frame before the first frame the tileset is rendered in.
  get readyPromise() {
    return this._readyPromise.promise;
  }

  // When <code>true</code>, all tiles this meet the screen space error this frame are loaded.
  // The tileset is
  get tilesLoaded() {
    return this._tilesLoaded;
  }

  // The url to a tileset JSON file.
  get url() {
    return this._url;
  }

  // The base path this non-absolute paths in tileset JSON file are relative to.
  get basePath() {
    // eslint-disable-next-line
    console.warn('Tileset3D.basePath is deprecated. Tiles are relative to the tileset JSON url');
    return this._basePath;
  }

  // The maximum screen space error used to drive level of detail refinement.
  get maximumScreenSpaceError() {
    return this._maximumScreenSpaceError;
  }

  set maximumScreenSpaceError(value) {
    assert(value >= 0);
    this._maximumScreenSpaceError = value;
  }

  // The maximum amount of GPU memory (in MB) this may be used to cache tiles. This value is estimated from
  // geometry, textures, and batch table textures of loaded tiles. For point clouds, this value also
  // includes per-point metadata.
  //
  // Tiles not in view are unloaded to enforce this.
  get maximumMemoryUsage() {
    return this._maximumMemoryUsage;
  }

  set maximumMemoryUsage(value) {
    assert(value > 0);
    this._maximumMemoryUsage = value;
  }

  // The root tile.
  get root() {
    this._checkReady();
    return this._root;
  }

  // The tileset's bounding sphere.
  get boundingSphere() {
    this._checkReady();
    this._root.updateTransform(this._modelMatrix);
    return this._root.boundingSphere;
  }

  // A 4x4 transformation matrix this transforms the entire tileset.
  get modelMatrix() {
    return this._modelMatrix;
  }

  set modelMatrix(modelMatrix) {
    this._modelMatrix = new Matrix4(modelMatrix);
  }

  // Returns the time, in milliseconds, since the tileset was loaded and first updated.
  get timeSinceLoad() {
    return this._timeSinceLoad;
  }

  // The total amount of GPU memory in bytes used by the tileset. This value is estimated from
  // geometry, texture, and batch table textures of loaded tiles. For point clouds, this value also
  // includes per-point metadata.
  get totalMemoryUsageInBytes() {
    return 0;
    // const statistics = this._statistics;
    // return statistics.texturesByteLength + statistics.geometryByteLength + statistics.batchTableByteLength;
  }

  // Gets an ellipsoid describing the shape of the globe.
  get ellipsoid() {
    return this._ellipsoid;
  }

  // Returns the extras property at the top of the tileset JSON (application specific metadata).
  get extras() {
    return this._extras;
  }

  // true if the tileset JSON file lists the extension in extensionsUsed
  hasExtension(extensionName) {
    return Boolean(this._extensionsUsed && this._extensionsUsed.indexOf(extensionName) > -1);
  }

  // Loads the main tileset JSON file or a tileset JSON file referenced from a tile.
  // eslint-disable-next-line max-statements
  loadTileset(tilesetJson, parentTile) {
    const asset = tilesetJson.asset;
    if (!asset) {
      throw new Error('Tileset must have an asset property.');
    }
    if (asset.version !== '0.0' && asset.version !== '1.0') {
      throw new Error('The tileset must be 3D Tiles version 0.0 or 1.0.');
    }

    const statistics = this._statistics;

    if ('tilesetVersion' in asset) {
      // Append the tileset version to the resource
      this._basePath += `?v=${asset.tilesetVersion}`;
    }

    // A tileset JSON file referenced from a tile may exist in a different directory than the root tileset.
    // Get the basePath relative to the external tileset.
    const rootTile = new Tile3DHeader(tilesetJson.root, parentTile, this, {}); // resource

    // If there is a parentTile, add the root of the currently loading tileset
    // to parentTile's children, and update its _depth.
    if (parentTile) {
      parentTile.children.push(rootTile);
      rootTile._depth = parentTile._depth + 1;
    }

    const stack = [];
    stack.push(rootTile);

    while (stack.length > 0) {
      // const tile = stack.pop();
      ++statistics.numberOfTilesTotal;
      // this._allTilesAdditive = this._allTilesAdditive && tile.refine === TILE_3D_REFINE.ADD;

      // const children = tile._header.children || [];
      // for (const childHeader of children) {
      //   const childTile = new Tile3D(this, resource, childHeader, tile);
      //   tile.children.push(childTile);
      //   childTile._depth = tile._depth + 1;
      //   stack.push(childTile);
      // }

      // TODO:
      // if (this._cullWithChildrenBounds) {
      //   Tile3DOptimizations.checkChildrenWithinParent(tile);
      // }
    }

    return rootTile;
  }

  // Unloads all tiles this weren't selected the previous frame.  This can be used to
  trimLoadedTiles() {
    this._cache.trim();
  }

  _requestTiles() {
    // Sort requests by priority before making any requests.
    // This makes it less likely this requests will be cancelled after being issued.
    this._requestedTiles.sort((a, b) => a._priority - b._priority);
    for (const requestedTile of this._requestedTiles) {
      this._requestContent(this, requestedTile);
    }
  }

  async _requestContent(tile) {
    if (tile.hasEmptyContent) {
      return;
    }

    const expired = tile.contentExpired;
    const requested = tile.requestContent();

    if (!requested) {
      return;
    }

    if (expired) {
      if (tile.hasTilesetContent) {
        this._destroySubtree(tile);
      }
    }

    try {
      await tile.contentReadyPromise;
      if (!tile.hasTilesetContent) {
        // Add to the tile cache. Previously expired tiles are already in the cache and won't get re-added.
        this._cache.add(tile);
      }

      this.onTileLoad(tile);
    } catch (error) {
      this.onTileLoadFailed({
        tile,
        url: tile.url,
        message: error.message || error.toString()
      });
    }
  }

  _destroySubtree(tile) {
    const root = tile;

    const stack = [];
    stack.push(root);

    while (stack.length > 0) {
      tile = stack.pop();
      for (const child of tile.children) {
        stack.push(child);
      }
      if (tile !== root) {
        this._destroyTile(tile);
      }
    }
    root.children = [];
  }

  _destroyTile(tile) {
    this._cache.unloadTile(this, tile);
    this.onTileUnload(tile);
    tile.unloadContent();
    tile.destroy();
  }

  _unloadTiles() {
    this._cache.unloadTiles(this, tile => {
      this.onTileUnload(tile);
      tile.unloadContent();
    });
  }

  _checkReady() {
    assert(this.ready, '3D Tileset is not loaded. Wait for Tileset3D.ready to be true.');
  }
}