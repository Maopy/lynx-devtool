// Copyright 2015 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/* eslint-disable rulesdir/no_underscored_properties */

import * as Common from '../../core/common/common.js';  // eslint-disable-line no-unused-vars
import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as Root from '../../core/root/root.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';
import * as UI from '../../ui/legacy/legacy.js';

import type {EmulatedDevice, Mode} from './EmulatedDevices.js';
import {Horizontal, HorizontalSpanned, Vertical, VerticalSpanned} from './EmulatedDevices.js';  // eslint-disable-line no-unused-vars

const UIStrings = {
  /**
  * @description Error message shown in the Devices settings pane when the user enters an invalid
  * width for a custom device.
  */
  widthMustBeANumber: 'Width must be a number.',
  /**
  * @description Error message shown in the Devices settings pane when the user has entered a width
  * for a custom device that is too large.
  * @example {9999} PH1
  */
  widthMustBeLessThanOrEqualToS: 'Width must be less than or equal to {PH1}.',
  /**
  * @description Error message shown in the Devices settings pane when the user has entered a width
  * for a custom device that is too small.
  * @example {50} PH1
  */
  widthMustBeGreaterThanOrEqualToS: 'Width must be greater than or equal to {PH1}.',
  /**
  * @description Error message shown in the Devices settings pane when the user enters an invalid
  * height for a custom device.
  */
  heightMustBeANumber: 'Height must be a number.',
  /**
  * @description Error message shown in the Devices settings pane when the user has entered a height
  * for a custom device that is too large.
  * @example {9999} PH1
  */
  heightMustBeLessThanOrEqualToS: 'Height must be less than or equal to {PH1}.',
  /**
  * @description Error message shown in the Devices settings pane when the user has entered a height
  * for a custom device that is too small.
  * @example {50} PH1
  */
  heightMustBeGreaterThanOrEqualTo: 'Height must be greater than or equal to {PH1}.',
  /**
  * @description Error message shown in the Devices settings pane when the user enters an invalid
  * device pixel ratio for a custom device.
  */
  devicePixelRatioMustBeANumberOr: 'Device pixel ratio must be a number or blank.',
  /**
  * @description Error message shown in the Devices settings pane when the user enters a device
  * pixel ratio for a custom device that is too large.
  * @example {10} PH1
  */
  devicePixelRatioMustBeLessThanOr: 'Device pixel ratio must be less than or equal to {PH1}.',
  /**
  * @description Error message shown in the Devices settings pane when the user enters a device
  * pixel ratio for a custom device that is too small.
  * @example {0} PH1
  */
  devicePixelRatioMustBeGreater: 'Device pixel ratio must be greater than or equal to {PH1}.',
};
const str_ = i18n.i18n.registerUIStrings('panels/emulation/DeviceModeModel.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

let deviceModeModelInstance: DeviceModeModel;

export class DeviceModeModel extends Common.ObjectWrapper.ObjectWrapper implements
    SDK.TargetManager.SDKModelObserver<SDK.EmulationModel.EmulationModel> {
  _screenRect: UI.Geometry.Rect;
  _visiblePageRect: UI.Geometry.Rect;
  _availableSize: UI.Geometry.Size;
  _preferredSize: UI.Geometry.Size;
  _initialized: boolean;
  _appliedDeviceSize: UI.Geometry.Size;
  _appliedDeviceScaleFactor: number;
  _appliedUserAgentType: UA;
  _experimentDualScreenSupport: boolean;
  _webPlatformExperimentalFeaturesEnabled: boolean;
  _scaleSetting: Common.Settings.Setting<number>;
  _scale: number;
  _widthSetting: Common.Settings.Setting<number>;
  _heightSetting: Common.Settings.Setting<number>;
  _uaSetting: Common.Settings.Setting<UA>;
  _deviceScaleFactorSetting: Common.Settings.Setting<number>;
  _deviceOutlineSetting: Common.Settings.Setting<boolean>;
  _toolbarControlsEnabledSetting: Common.Settings.Setting<boolean>;
  _type: Type;
  _device: EmulatedDevice|null;
  _mode: Mode|null;
  _fitScale: number;
  _touchEnabled: boolean;
  _touchMobile: boolean;
  _emulationModel: SDK.EmulationModel.EmulationModel|null;
  _onModelAvailable: (() => void)|null;
  _emulatedPageSize?: UI.Geometry.Size;
  _outlineRect?: UI.Geometry.Rect;

  private constructor() {
    super();
    this._screenRect = new UI.Geometry.Rect(0, 0, 1, 1);
    this._visiblePageRect = new UI.Geometry.Rect(0, 0, 1, 1);
    this._availableSize = new UI.Geometry.Size(1, 1);
    this._preferredSize = new UI.Geometry.Size(1, 1);
    this._initialized = false;
    this._appliedDeviceSize = new UI.Geometry.Size(1, 1);
    this._appliedDeviceScaleFactor = window.devicePixelRatio;
    this._appliedUserAgentType = UA.Desktop;
    this._experimentDualScreenSupport = Root.Runtime.experiments.isEnabled('dualScreenSupport');
    this._webPlatformExperimentalFeaturesEnabled = Boolean(eval('window.getWindowSegments'));

    this._scaleSetting = Common.Settings.Settings.instance().createSetting('emulation.deviceScale', 1);
    // We've used to allow zero before.
    if (!this._scaleSetting.get()) {
      this._scaleSetting.set(1);
    }
    this._scaleSetting.addChangeListener(this._scaleSettingChanged, this);
    this._scale = 1;

    this._widthSetting = Common.Settings.Settings.instance().createSetting('emulation.deviceWidth', 400);
    if (this._widthSetting.get() < MinDeviceSize) {
      this._widthSetting.set(MinDeviceSize);
    }
    if (this._widthSetting.get() > MaxDeviceSize) {
      this._widthSetting.set(MaxDeviceSize);
    }
    this._widthSetting.addChangeListener(this._widthSettingChanged, this);

    this._heightSetting = Common.Settings.Settings.instance().createSetting('emulation.deviceHeight', 0);
    if (this._heightSetting.get() && this._heightSetting.get() < MinDeviceSize) {
      this._heightSetting.set(MinDeviceSize);
    }
    if (this._heightSetting.get() > MaxDeviceSize) {
      this._heightSetting.set(MaxDeviceSize);
    }
    this._heightSetting.addChangeListener(this._heightSettingChanged, this);

    this._uaSetting = Common.Settings.Settings.instance().createSetting('emulation.deviceUA', UA.Mobile);
    this._uaSetting.addChangeListener(this._uaSettingChanged, this);
    this._deviceScaleFactorSetting =
        Common.Settings.Settings.instance().createSetting('emulation.deviceScaleFactor', 0);
    this._deviceScaleFactorSetting.addChangeListener(this._deviceScaleFactorSettingChanged, this);

    this._deviceOutlineSetting = Common.Settings.Settings.instance().moduleSetting('emulation.showDeviceOutline');
    this._deviceOutlineSetting.addChangeListener(this._deviceOutlineSettingChanged, this);

    this._toolbarControlsEnabledSetting = Common.Settings.Settings.instance().createSetting(
        'emulation.toolbarControlsEnabled', true, Common.Settings.SettingStorageType.Session);

    this._type = Type.None;
    this._device = null;
    this._mode = null;
    this._fitScale = 1;
    this._touchEnabled = false;
    this._touchMobile = false;

    this._emulationModel = null;
    this._onModelAvailable = null;
    SDK.TargetManager.TargetManager.instance().observeModels(SDK.EmulationModel.EmulationModel, this);
  }

  static instance(opts: {
    forceNew: null,
  } = {forceNew: null}): DeviceModeModel {
    if (!deviceModeModelInstance || opts.forceNew) {
      deviceModeModelInstance = new DeviceModeModel();
    }

    return deviceModeModelInstance;
  }

  static widthValidator(value: string): {
    valid: boolean,
    errorMessage: (string|undefined),
  } {
    let valid = false;
    let errorMessage;

    if (!/^[\d]+$/.test(value)) {
      errorMessage = i18nString(UIStrings.widthMustBeANumber);
    } else if (Number(value) > MaxDeviceSize) {
      errorMessage = i18nString(UIStrings.widthMustBeLessThanOrEqualToS, {PH1: MaxDeviceSize});
    } else if (Number(value) < MinDeviceSize) {
      errorMessage = i18nString(UIStrings.widthMustBeGreaterThanOrEqualToS, {PH1: MinDeviceSize});
    } else {
      valid = true;
    }

    return {valid, errorMessage};
  }

  static heightValidator(value: string): {
    valid: boolean,
    errorMessage: (string|undefined),
  } {
    let valid = false;
    let errorMessage;

    if (!/^[\d]+$/.test(value)) {
      errorMessage = i18nString(UIStrings.heightMustBeANumber);
    } else if (Number(value) > MaxDeviceSize) {
      errorMessage = i18nString(UIStrings.heightMustBeLessThanOrEqualToS, {PH1: MaxDeviceSize});
    } else if (Number(value) < MinDeviceSize) {
      errorMessage = i18nString(UIStrings.heightMustBeGreaterThanOrEqualTo, {PH1: MinDeviceSize});
    } else {
      valid = true;
    }

    return {valid, errorMessage};
  }

  static scaleValidator(value: string): {
    valid: boolean,
    errorMessage: (string|undefined),
  } {
    let valid = false;
    let errorMessage;
    const parsedValue = Number(value.trim());

    if (!value) {
      valid = true;
    } else if (Number.isNaN(parsedValue)) {
      errorMessage = i18nString(UIStrings.devicePixelRatioMustBeANumberOr);
    } else if (Number(value) > MaxDeviceScaleFactor) {
      errorMessage = i18nString(UIStrings.devicePixelRatioMustBeLessThanOr, {PH1: MaxDeviceScaleFactor});
    } else if (Number(value) < MinDeviceScaleFactor) {
      errorMessage = i18nString(UIStrings.devicePixelRatioMustBeGreater, {PH1: MinDeviceScaleFactor});
    } else {
      valid = true;
    }

    return {valid, errorMessage};
  }

  setAvailableSize(availableSize: UI.Geometry.Size, preferredSize: UI.Geometry.Size): void {
    this._availableSize = availableSize;
    this._preferredSize = preferredSize;
    this._initialized = true;
    this._calculateAndEmulate(false);
  }

  emulate(type: Type, device: EmulatedDevice|null, mode: Mode|null, scale?: number): void {
    const resetPageScaleFactor = this._type !== type || this._device !== device || this._mode !== mode;
    this._type = type;

    if (type === Type.Device && device && mode) {
      console.assert(Boolean(device) && Boolean(mode), 'Must pass device and mode for device emulation');
      this._mode = mode;
      this._device = device;
      if (this._initialized) {
        const orientation = device.orientationByName(mode.orientation);
        this._scaleSetting.set(
            scale ||
            this._calculateFitScale(
                orientation.width, orientation.height, this._currentOutline(), this._currentInsets()));
      }
    } else {
      this._device = null;
      this._mode = null;
    }

    if (type !== Type.None) {
      Host.userMetrics.actionTaken(Host.UserMetrics.Action.DeviceModeEnabled);
    }
    this._calculateAndEmulate(resetPageScaleFactor);
  }

  setWidth(width: number): void {
    const max = Math.min(MaxDeviceSize, this._preferredScaledWidth());
    width = Math.max(Math.min(width, max), 1);
    this._widthSetting.set(width);
  }

  setWidthAndScaleToFit(width: number): void {
    width = Math.max(Math.min(width, MaxDeviceSize), 1);
    this._scaleSetting.set(this._calculateFitScale(width, this._heightSetting.get()));
    this._widthSetting.set(width);
  }

  setHeight(height: number): void {
    const max = Math.min(MaxDeviceSize, this._preferredScaledHeight());
    height = Math.max(Math.min(height, max), 0);
    if (height === this._preferredScaledHeight()) {
      height = 0;
    }
    this._heightSetting.set(height);
  }

  setHeightAndScaleToFit(height: number): void {
    height = Math.max(Math.min(height, MaxDeviceSize), 0);
    this._scaleSetting.set(this._calculateFitScale(this._widthSetting.get(), height));
    this._heightSetting.set(height);
  }

  setScale(scale: number): void {
    this._scaleSetting.set(scale);
  }

  device(): EmulatedDevice|null {
    return this._device;
  }

  mode(): Mode|null {
    return this._mode;
  }

  type(): Type {
    return this._type;
  }

  screenImage(): string {
    return (this._device && this._mode) ? this._device.modeImage(this._mode) : '';
  }

  outlineImage(): string {
    return (this._device && this._mode && this._deviceOutlineSetting.get()) ? this._device.outlineImage(this._mode) :
                                                                              '';
  }

  outlineRect(): UI.Geometry.Rect|null {
    return this._outlineRect || null;
  }

  screenRect(): UI.Geometry.Rect {
    return this._screenRect;
  }

  visiblePageRect(): UI.Geometry.Rect {
    return this._visiblePageRect;
  }

  scale(): number {
    return this._scale;
  }

  fitScale(): number {
    return this._fitScale;
  }

  appliedDeviceSize(): UI.Geometry.Size {
    return this._appliedDeviceSize;
  }

  appliedDeviceScaleFactor(): number {
    return this._appliedDeviceScaleFactor;
  }

  appliedUserAgentType(): UA {
    return this._appliedUserAgentType;
  }

  isFullHeight(): boolean {
    return !this._heightSetting.get();
  }

  _isMobile(): boolean {
    switch (this._type) {
      case Type.Device:
        return this._device ? this._device.mobile() : false;
      case Type.None:
        return false;
      case Type.Responsive:
        return this._uaSetting.get() === UA.Mobile || this._uaSetting.get() === UA.MobileNoTouch;
    }
    return false;
  }

  enabledSetting(): Common.Settings.Setting<boolean> {
    return Common.Settings.Settings.instance().createSetting('emulation.showDeviceMode', false);
  }

  scaleSetting(): Common.Settings.Setting<number> {
    return this._scaleSetting;
  }

  uaSetting(): Common.Settings.Setting<UA> {
    return this._uaSetting;
  }

  deviceScaleFactorSetting(): Common.Settings.Setting<number> {
    return this._deviceScaleFactorSetting;
  }

  deviceOutlineSetting(): Common.Settings.Setting<boolean> {
    return this._deviceOutlineSetting;
  }

  toolbarControlsEnabledSetting(): Common.Settings.Setting<boolean> {
    return this._toolbarControlsEnabledSetting;
  }

  reset(): void {
    this._deviceScaleFactorSetting.set(0);
    this._scaleSetting.set(1);
    this.setWidth(400);
    this.setHeight(0);
    this._uaSetting.set(UA.Mobile);
  }

  modelAdded(emulationModel: SDK.EmulationModel.EmulationModel): void {
    if (!this._emulationModel && emulationModel.supportsDeviceEmulation()) {
      this._emulationModel = emulationModel;
      if (this._onModelAvailable) {
        const callback = this._onModelAvailable;
        this._onModelAvailable = null;
        callback();
      }
      const resourceTreeModel = emulationModel.target().model(SDK.ResourceTreeModel.ResourceTreeModel);
      if (resourceTreeModel) {
        resourceTreeModel.addEventListener(SDK.ResourceTreeModel.Events.FrameResized, this._onFrameChange, this);
        resourceTreeModel.addEventListener(SDK.ResourceTreeModel.Events.FrameNavigated, this._onFrameChange, this);
      }
    } else {
      emulationModel.emulateTouch(this._touchEnabled, this._touchMobile);
    }
  }

  modelRemoved(emulationModel: SDK.EmulationModel.EmulationModel): void {
    if (this._emulationModel === emulationModel) {
      this._emulationModel = null;
    }
  }

  inspectedURL(): string|null {
    return this._emulationModel ? this._emulationModel.target().inspectedURL() : null;
  }

  _onFrameChange(): void {
    const overlayModel = this._emulationModel ? this._emulationModel.overlayModel() : null;
    if (!overlayModel) {
      return;
    }

    this._showHingeIfApplicable(overlayModel);
  }

  _scaleSettingChanged(): void {
    this._calculateAndEmulate(false);
  }

  _widthSettingChanged(): void {
    this._calculateAndEmulate(false);
  }

  _heightSettingChanged(): void {
    this._calculateAndEmulate(false);
  }

  _uaSettingChanged(): void {
    this._calculateAndEmulate(true);
  }

  _deviceScaleFactorSettingChanged(): void {
    this._calculateAndEmulate(false);
  }

  _deviceOutlineSettingChanged(): void {
    this._calculateAndEmulate(false);
  }

  _preferredScaledWidth(): number {
    return Math.floor(this._preferredSize.width / (this._scaleSetting.get() || 1));
  }

  _preferredScaledHeight(): number {
    return Math.floor(this._preferredSize.height / (this._scaleSetting.get() || 1));
  }

  _currentOutline(): UI.Geometry.Insets {
    let outline: UI.Geometry.Insets = new UI.Geometry.Insets(0, 0, 0, 0);
    if (this._type !== Type.Device || !this._device || !this._mode) {
      return outline;
    }
    const orientation = this._device.orientationByName(this._mode.orientation);
    if (this._deviceOutlineSetting.get()) {
      outline = orientation.outlineInsets || outline;
    }
    return outline;
  }

  _currentInsets(): UI.Geometry.Insets {
    if (this._type !== Type.Device || !this._mode) {
      return new UI.Geometry.Insets(0, 0, 0, 0);
    }
    return this._mode.insets;
  }

  _getScreenOrientationType(): Protocol.Emulation.ScreenOrientationType {
    if (!this._mode) {
      throw new Error('Mode required to get orientation type.');
    }
    switch (this._mode.orientation) {
      case VerticalSpanned:
      case Vertical:
        return Protocol.Emulation.ScreenOrientationType.PortraitPrimary;
      case HorizontalSpanned:
      case Horizontal:
      default:
        return Protocol.Emulation.ScreenOrientationType.LandscapePrimary;
    }
  }

  _calculateAndEmulate(resetPageScaleFactor: boolean): void {
    if (!this._emulationModel) {
      this._onModelAvailable = this._calculateAndEmulate.bind(this, resetPageScaleFactor);
    }
    const mobile = this._isMobile();
    const overlayModel = this._emulationModel ? this._emulationModel.overlayModel() : null;
    if (overlayModel) {
      this._showHingeIfApplicable(overlayModel);
    }
    if (this._type === Type.Device && this._device && this._mode) {
      const orientation = this._device.orientationByName(this._mode.orientation);
      const outline = this._currentOutline();
      const insets = this._currentInsets();
      this._fitScale = this._calculateFitScale(orientation.width, orientation.height, outline, insets);
      if (mobile) {
        this._appliedUserAgentType = this._device.touch() ? UA.Mobile : UA.MobileNoTouch;
      } else {
        this._appliedUserAgentType = this._device.touch() ? UA.DesktopTouch : UA.Desktop;
      }
      this._applyDeviceMetrics(
          new UI.Geometry.Size(orientation.width, orientation.height), insets, outline, this._scaleSetting.get(),
          this._device.deviceScaleFactor, mobile, this._getScreenOrientationType(), resetPageScaleFactor,
          this._webPlatformExperimentalFeaturesEnabled);
      this._applyUserAgent(this._device.userAgent, this._device.userAgentMetadata);
      this._applyTouch(this._device.touch(), mobile);
    } else if (this._type === Type.None) {
      this._fitScale = this._calculateFitScale(this._availableSize.width, this._availableSize.height);
      this._appliedUserAgentType = UA.Desktop;
      this._applyDeviceMetrics(
          this._availableSize, new UI.Geometry.Insets(0, 0, 0, 0), new UI.Geometry.Insets(0, 0, 0, 0), 1, 0, mobile,
          null, resetPageScaleFactor);
      this._applyUserAgent('', null);
      this._applyTouch(false, false);
    } else if (this._type === Type.Responsive) {
      let screenWidth = this._widthSetting.get();
      if (!screenWidth || screenWidth > this._preferredScaledWidth()) {
        screenWidth = this._preferredScaledWidth();
      }
      let screenHeight = this._heightSetting.get();
      if (!screenHeight || screenHeight > this._preferredScaledHeight()) {
        screenHeight = this._preferredScaledHeight();
      }
      const defaultDeviceScaleFactor = mobile ? defaultMobileScaleFactor : 0;
      this._fitScale = this._calculateFitScale(this._widthSetting.get(), this._heightSetting.get());
      this._appliedUserAgentType = this._uaSetting.get();
      this._applyDeviceMetrics(
          new UI.Geometry.Size(screenWidth, screenHeight), new UI.Geometry.Insets(0, 0, 0, 0),
          new UI.Geometry.Insets(0, 0, 0, 0), this._scaleSetting.get(),
          this._deviceScaleFactorSetting.get() || defaultDeviceScaleFactor, mobile,
          screenHeight >= screenWidth ? Protocol.Emulation.ScreenOrientationType.PortraitPrimary :
                                        Protocol.Emulation.ScreenOrientationType.LandscapePrimary,
          resetPageScaleFactor);
      this._applyUserAgent(mobile ? defaultMobileUserAgent : '', mobile ? defaultMobileUserAgentMetadata : null);
      this._applyTouch(
          this._uaSetting.get() === UA.DesktopTouch || this._uaSetting.get() === UA.Mobile,
          this._uaSetting.get() === UA.Mobile);
    }

    if (overlayModel) {
      overlayModel.setShowViewportSizeOnResize(this._type === Type.None);
    }
    this.dispatchEventToListeners(Events.Updated);
  }

  _calculateFitScale(
      screenWidth: number, screenHeight: number, outline?: UI.Geometry.Insets, insets?: UI.Geometry.Insets): number {
    const outlineWidth = outline ? outline.left + outline.right : 0;
    const outlineHeight = outline ? outline.top + outline.bottom : 0;
    const insetsWidth = insets ? insets.left + insets.right : 0;
    const insetsHeight = insets ? insets.top + insets.bottom : 0;
    let scale = Math.min(
        screenWidth ? this._preferredSize.width / (screenWidth + outlineWidth) : 1,
        screenHeight ? this._preferredSize.height / (screenHeight + outlineHeight) : 1);
    scale = Math.min(Math.floor(scale * 100), 100);

    let sharpScale = scale;
    while (sharpScale > scale * 0.7) {
      let sharp = true;
      if (screenWidth) {
        sharp = sharp && Number.isInteger((screenWidth - insetsWidth) * sharpScale / 100);
      }
      if (screenHeight) {
        sharp = sharp && Number.isInteger((screenHeight - insetsHeight) * sharpScale / 100);
      }
      if (sharp) {
        return sharpScale / 100;
      }
      sharpScale -= 1;
    }
    return scale / 100;
  }

  setSizeAndScaleToFit(width: number, height: number): void {
    this._scaleSetting.set(this._calculateFitScale(width, height));
    this.setWidth(width);
    this.setHeight(height);
  }

  _applyUserAgent(userAgent: string, userAgentMetadata: Protocol.Emulation.UserAgentMetadata|null): void {
    SDK.NetworkManager.MultitargetNetworkManager.instance().setUserAgentOverride(userAgent, userAgentMetadata);
  }

  _applyDeviceMetrics(
      screenSize: UI.Geometry.Size, insets: UI.Geometry.Insets, outline: UI.Geometry.Insets, scale: number,
      deviceScaleFactor: number, mobile: boolean, screenOrientation: Protocol.Emulation.ScreenOrientationType|null,
      resetPageScaleFactor: boolean, forceMetricsOverride: boolean|undefined = false): void {
    screenSize.width = Math.max(1, Math.floor(screenSize.width));
    screenSize.height = Math.max(1, Math.floor(screenSize.height));

    let pageWidth: 0|number = screenSize.width - insets.left - insets.right;
    let pageHeight: 0|number = screenSize.height - insets.top - insets.bottom;
    this._emulatedPageSize = new UI.Geometry.Size(pageWidth, pageHeight);

    const positionX = insets.left;
    const positionY = insets.top;
    const screenOrientationAngle =
        screenOrientation === Protocol.Emulation.ScreenOrientationType.LandscapePrimary ? 90 : 0;

    this._appliedDeviceSize = screenSize;
    this._appliedDeviceScaleFactor = deviceScaleFactor || window.devicePixelRatio;
    this._screenRect = new UI.Geometry.Rect(
        Math.max(0, (this._availableSize.width - screenSize.width * scale) / 2), outline.top * scale,
        screenSize.width * scale, screenSize.height * scale);
    this._outlineRect = new UI.Geometry.Rect(
        this._screenRect.left - outline.left * scale, 0, (outline.left + screenSize.width + outline.right) * scale,
        (outline.top + screenSize.height + outline.bottom) * scale);
    this._visiblePageRect = new UI.Geometry.Rect(
        positionX * scale, positionY * scale,
        Math.min(pageWidth * scale, this._availableSize.width - this._screenRect.left - positionX * scale),
        Math.min(pageHeight * scale, this._availableSize.height - this._screenRect.top - positionY * scale));
    this._scale = scale;
    if (!forceMetricsOverride) {
      // When sending displayFeature, we cannot use the optimization below due to backend restrictions.
      if (scale === 1 && this._availableSize.width >= screenSize.width &&
          this._availableSize.height >= screenSize.height) {
        // When we have enough space, no page size override is required. This will speed things up and remove lag.
        pageWidth = 0;
        pageHeight = 0;
      }
      if (this._visiblePageRect.width === pageWidth * scale && this._visiblePageRect.height === pageHeight * scale &&
          Number.isInteger(pageWidth * scale) && Number.isInteger(pageHeight * scale)) {
        // When we only have to apply scale, do not resize the page. This will speed things up and remove lag.
        pageWidth = 0;
        pageHeight = 0;
      }
    }

    if (!this._emulationModel) {
      return;
    }

    if (resetPageScaleFactor) {
      this._emulationModel.resetPageScaleFactor();
    }
    if (pageWidth || pageHeight || mobile || deviceScaleFactor || scale !== 1 || screenOrientation ||
        forceMetricsOverride) {
      const metrics: Protocol.Emulation.SetDeviceMetricsOverrideRequest = {
        width: pageWidth,
        height: pageHeight,
        deviceScaleFactor: deviceScaleFactor,
        mobile: mobile,
        scale: scale,
        screenWidth: screenSize.width,
        screenHeight: screenSize.height,
        positionX: positionX,
        positionY: positionY,
        dontSetVisibleSize: true,
        displayFeature: undefined,
        screenOrientation: undefined,
      };
      const displayFeature = this._getDisplayFeature();
      if (displayFeature) {
        metrics.displayFeature = displayFeature;
      }
      if (screenOrientation) {
        metrics.screenOrientation = {type: screenOrientation, angle: screenOrientationAngle};
      }
      this._emulationModel.emulateDevice(metrics);
    } else {
      this._emulationModel.emulateDevice(null);
    }
  }

  exitHingeMode(): void {
    const overlayModel = this._emulationModel ? this._emulationModel.overlayModel() : null;
    if (overlayModel) {
      overlayModel.showHingeForDualScreen(null);
    }
  }

  webPlatformExperimentalFeaturesEnabled(): boolean {
    return this._webPlatformExperimentalFeaturesEnabled;
  }

  shouldReportDisplayFeature(): boolean {
    return this._webPlatformExperimentalFeaturesEnabled && this._experimentDualScreenSupport;
  }

  async captureScreenshot(fullSize: boolean, clip?: Protocol.Page.Viewport): Promise<string|null> {
    const screenCaptureModel =
        this._emulationModel ? this._emulationModel.target().model(SDK.ScreenCaptureModel.ScreenCaptureModel) : null;
    if (!screenCaptureModel) {
      return null;
    }

    const overlayModel = this._emulationModel ? this._emulationModel.overlayModel() : null;
    if (overlayModel) {
      overlayModel.setShowViewportSizeOnResize(false);
    }

    // Define the right clipping area for fullsize screenshots.
    if (fullSize) {
      const metrics = await screenCaptureModel.fetchLayoutMetrics();
      if (!metrics) {
        return null;
      }

      // Cap the height to not hit the GPU limit.
      const contentHeight = Math.min((1 << 14), metrics.contentHeight);
      clip = {x: 0, y: 0, width: Math.floor(metrics.contentWidth), height: Math.floor(contentHeight), scale: 1};
    }
    const screenshot =
        await screenCaptureModel.captureScreenshot(Protocol.Page.CaptureScreenshotRequestFormat.Png, 100, clip);

    const deviceMetrics: Protocol.Page.SetDeviceMetricsOverrideRequest = {
      width: 0,
      height: 0,
      deviceScaleFactor: 0,
      mobile: false,
    };
    if (fullSize && this._emulationModel) {
      if (this._device && this._mode) {
        const orientation = this._device.orientationByName(this._mode.orientation);
        deviceMetrics.width = orientation.width;
        deviceMetrics.height = orientation.height;
        const dispFeature = this._getDisplayFeature();
        if (dispFeature) {
          // @ts-ignore: displayFeature isn't in protocol.d.ts but is an
          // experimental flag:
          // https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride
          deviceMetrics.displayFeature = dispFeature;
        }
      } else {
        deviceMetrics.width = 0;
        deviceMetrics.height = 0;
      }
      await this._emulationModel.emulateDevice(deviceMetrics);
    }
    this._calculateAndEmulate(false);
    return screenshot;
  }

  _applyTouch(touchEnabled: boolean, mobile: boolean): void {
    this._touchEnabled = touchEnabled;
    this._touchMobile = mobile;
    for (const emulationModel of SDK.TargetManager.TargetManager.instance().models(SDK.EmulationModel.EmulationModel)) {
      emulationModel.emulateTouch(touchEnabled, mobile);
    }
  }

  _showHingeIfApplicable(overlayModel: SDK.OverlayModel.OverlayModel): void {
    const orientation = (this._device && this._mode) ? this._device.orientationByName(this._mode.orientation) : null;
    if (this._experimentDualScreenSupport && orientation && orientation.hinge) {
      overlayModel.showHingeForDualScreen(orientation.hinge);
      return;
    }

    overlayModel.showHingeForDualScreen(null);
  }

  _getDisplayFeatureOrientation(): Protocol.Emulation.DisplayFeatureOrientation {
    if (!this._mode) {
      throw new Error('Mode required to get display feature orientation.');
    }
    switch (this._mode.orientation) {
      case VerticalSpanned:
      case Vertical:
        return Protocol.Emulation.DisplayFeatureOrientation.Vertical;
      case HorizontalSpanned:
      case Horizontal:
      default:
        return Protocol.Emulation.DisplayFeatureOrientation.Horizontal;
    }
  }

  _getDisplayFeature(): Protocol.Emulation.DisplayFeature|null {
    if (!this.shouldReportDisplayFeature()) {
      return null;
    }

    if (!this._device || !this._mode ||
        (this._mode.orientation !== VerticalSpanned && this._mode.orientation !== HorizontalSpanned)) {
      return null;
    }

    const orientation = this._device.orientationByName(this._mode.orientation);
    if (!orientation || !orientation.hinge) {
      return null;
    }

    const hinge = orientation.hinge;
    return {
      orientation: this._getDisplayFeatureOrientation(),
      offset: (this._mode.orientation === VerticalSpanned) ? hinge.x : hinge.y,
      maskLength: (this._mode.orientation === VerticalSpanned) ? hinge.width : hinge.height,
    };
  }
}

export const enum Events {
  Updated = 'Updated',
}


// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum Type {
  None = 'None',
  Responsive = 'Responsive',
  Device = 'Device',
}


// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum UA {
  // TODO(crbug.com/1136655): This enum is used for both display and code functionality.
  // we should refactor this so localization of these strings only happens for user display.
  Mobile = 'Mobile',
  MobileNoTouch = 'Mobile (no touch)',
  Desktop = 'Desktop',
  DesktopTouch = 'Desktop (touch)',
}


export const MinDeviceSize = 50;
export const MaxDeviceSize = 9999;
export const MinDeviceScaleFactor = 0;
export const MaxDeviceScaleFactor = 10;
export const MaxDeviceNameLength = 50;

const mobileUserAgent =
    'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36';
const defaultMobileUserAgent =
    SDK.NetworkManager.MultitargetNetworkManager.patchUserAgentWithChromeVersion(mobileUserAgent);

const defaultMobileUserAgentMetadata = {
  platform: 'Android',
  platformVersion: '6.0',
  architecture: '',
  model: 'Nexus 5',
  mobile: true,
};
export const defaultMobileScaleFactor = 2;
