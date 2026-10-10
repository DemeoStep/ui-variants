// Built-in simplified device frames without external packages. The mod puts this
// file in place of lib/_host/frames.dart if device_frame is incompatible with the
// project's dependencies. The interface is the same.
import 'package:flutter/material.dart';

/// A device in the picker list.
class PreviewDevice {
  const PreviewDevice({
    required this.id,
    required this.name,
    required this.isTablet,
    required this.platform,
  });

  final String id;
  final String name;
  final bool isTablet;
  final TargetPlatform platform;
}

/// The frames are built-in and simplified, not realistic (device_frame).
const bool hasRealFrames = false;

class _Spec {
  const _Spec(this.device, this.size, this.top, this.bottom, this.radius,
      {this.hasIsland = false, this.hasNotch = false});

  final PreviewDevice device;
  final Size size;
  final double top;
  final double bottom;
  final double radius;
  final bool hasIsland;
  final bool hasNotch;
}

PreviewDevice _iphone(String id, String name) => PreviewDevice(
    id: 'builtin/$id', name: name, isTablet: false, platform: TargetPlatform.iOS);

/// iPhone sizes and safe areas are from useyourloaf.com.
final List<_Spec> _specs = <_Spec>[
  _Spec(_iphone('iphone_17', 'iPhone 17'), const Size(402, 874), 62, 34, 56,
      hasIsland: true),
  _Spec(_iphone('iphone_17_pro_max', 'iPhone 17 Pro Max'),
      const Size(440, 956), 62, 34, 56,
      hasIsland: true),
  _Spec(_iphone('iphone_air', 'iPhone Air'), const Size(420, 912), 68, 34, 56,
      hasIsland: true),
  _Spec(_iphone('iphone_16e', 'iPhone 16e'), const Size(390, 844), 47, 34, 47,
      hasNotch: true),
  _Spec(_iphone('iphone_se', 'iPhone SE'), const Size(375, 667), 20, 0, 4),
  const _Spec(
      PreviewDevice(
          id: 'builtin/pixel_8',
          name: 'Pixel 8',
          isTablet: false,
          platform: TargetPlatform.android),
      Size(412, 915),
      32,
      24,
      34),
  const _Spec(
      PreviewDevice(
          id: 'builtin/ipad_air',
          name: 'iPad Air 11"',
          isTablet: true,
          platform: TargetPlatform.iOS),
      Size(820, 1180),
      24,
      20,
      18),
];

/// The built-in devices.
List<PreviewDevice> previewDevices() =>
    <PreviewDevice>[for (final spec in _specs) spec.device];

/// The default device.
String defaultDeviceId() => _specs.first.device.id;

/// [screen] in a simplified frame; the frame fits the available space.
Widget deviceFrame({
  required String deviceId,
  required bool isLandscape,
  required Widget screen,
}) {
  final spec = _specs.firstWhere(
    (item) => item.device.id == deviceId,
    orElse: () => _specs.first,
  );
  final size =
      isLandscape ? Size(spec.size.height, spec.size.width) : spec.size;
  final padding = isLandscape
      ? EdgeInsets.only(left: spec.top, right: spec.top, bottom: spec.bottom)
      : EdgeInsets.only(top: spec.top, bottom: spec.bottom);
  const bezel = 14.0;
  return FittedBox(
    child: Container(
      padding: const EdgeInsets.all(bezel),
      decoration: BoxDecoration(
        color: const Color(0xFF1C1C1E),
        borderRadius: BorderRadius.circular(spec.radius + bezel),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(spec.radius),
        child: SizedBox.fromSize(
          size: size,
          child: Builder(
            builder: (context) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                size: size,
                padding: padding,
                viewPadding: padding,
                viewInsets: EdgeInsets.zero,
              ),
              child: Stack(
                children: <Widget>[
                  Positioned.fill(child: screen),
                  if ((spec.hasIsland || spec.hasNotch) && !isLandscape)
                    Positioned(
                      top: spec.hasNotch ? 0 : 11,
                      left: (size.width - (spec.hasNotch ? 162 : 126)) / 2,
                      child: Container(
                        width: spec.hasNotch ? 162 : 126,
                        height: spec.hasNotch ? 32 : 37,
                        decoration: BoxDecoration(
                          color: Colors.black,
                          borderRadius: spec.hasNotch
                              ? const BorderRadius.vertical(
                                  bottom: Radius.circular(20))
                              : BorderRadius.circular(20),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
