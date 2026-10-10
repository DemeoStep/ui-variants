// Рамки устройств для предпросмотра на пакете device_frame. Если pub не может
// подобрать device_frame к зависимостям проекта, мод заменяет этот файл
// встроенными рамками с тем же интерфейсом (fallback/frames.dart).
import 'package:device_frame/device_frame.dart';
import 'package:flutter/widgets.dart';

/// Устройство в списке выбора.
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

/// Рамки реалистичные (device_frame), а не встроенные упрощённые.
const bool hasRealFrames = true;

/// iPhone новее тех, что есть в device_frame. Размеры экрана и безопасные
/// зоны — по useyourloaf.com/blog/iphone-17-screen-sizes (у 16e — как у
/// iPhone 14, на корпусе которого он сделан); рамка — общая, настроенная под
/// современный iPhone, Dynamic Island или вырез рисуются поверх экрана.
class _ExtraIphone {
  const _ExtraIphone(this.id, this.name, this.size, this.top,
      this.landscapeSide, this.landscapeBottom,
      {this.hasNotch = false});

  final String id;
  final String name;
  final Size size;
  final double top;
  final double landscapeSide;
  final double landscapeBottom;
  final bool hasNotch;
}

const List<_ExtraIphone> _extraIphones = <_ExtraIphone>[
  _ExtraIphone('iphone-17', 'iPhone 17', Size(402, 874), 62, 62, 20),
  _ExtraIphone('iphone-17-pro', 'iPhone 17 Pro', Size(402, 874), 62, 62, 20),
  _ExtraIphone(
      'iphone-17-pro-max', 'iPhone 17 Pro Max', Size(440, 956), 62, 62, 20),
  _ExtraIphone('iphone-air', 'iPhone Air', Size(420, 912), 68, 68, 29),
  _ExtraIphone('iphone-16e', 'iPhone 16e', Size(390, 844), 47, 47, 21,
      hasNotch: true),
];

const GenericPhoneFramePainter _modernIphoneFrame = GenericPhoneFramePainter(
  outerBodyColor: Color(0xff4a4d52),
  innerBodyColor: Color(0xff0b0b0c),
  outerBodyRadius: Radius.circular(70),
  innerBodyRadius: Radius.circular(66),
  innerBodyInsets: EdgeInsets.all(3),
  screenInsets: EdgeInsets.all(12),
  screenRadius: Radius.circular(56),
  buttonWidth: 3,
  rightSideButtonsGapsAndSizes: <double>[210, 95],
  topSideButtonsGapsAndSizes: <double>[],
  cameraRadius: 0,
  cameraBorderWidth: 0,
);

DeviceInfo _extraInfo(_ExtraIphone phone) => DeviceInfo.genericPhone(
      platform: TargetPlatform.iOS,
      id: phone.id,
      name: phone.name,
      screenSize: phone.size,
      safeAreas: EdgeInsets.only(top: phone.top, bottom: 34),
      rotatedSafeAreas: EdgeInsets.only(
          left: phone.landscapeSide,
          right: phone.landscapeSide,
          bottom: phone.landscapeBottom),
      pixelRatio: 3,
      framePainter: _modernIphoneFrame,
    );

List<DeviceInfo> _infos() {
  return <DeviceInfo>[
    for (final phone in _extraIphones) _extraInfo(phone),
    ...Devices.ios.all,
    ...Devices.android.all,
  ]
      .where((info) =>
          info.identifier.type == DeviceType.phone ||
          info.identifier.type == DeviceType.tablet)
      .toList();
}

_ExtraIphone? _extraOf(String deviceId) {
  for (final phone in _extraIphones) {
    if (deviceId == 'iOS/${phone.id}') return phone;
  }
  return null;
}

/// Dynamic Island или вырез поверх экрана добавленных iPhone.
Widget _withCutout(_ExtraIphone phone, bool isLandscape, Widget screen) {
  final width = phone.hasNotch ? 162.0 : 126.0;
  final height = phone.hasNotch ? 32.0 : 37.0;
  final offset = phone.hasNotch ? 0.0 : 11.0;
  final radius = phone.hasNotch
      ? (isLandscape
          ? const BorderRadius.horizontal(right: Radius.circular(20))
          : const BorderRadius.vertical(bottom: Radius.circular(20)))
      : BorderRadius.circular(20);
  final cutout = Container(
    width: isLandscape ? height : width,
    height: isLandscape ? width : height,
    decoration: BoxDecoration(color: const Color(0xff000000), borderRadius: radius),
  );
  return Stack(
    children: <Widget>[
      Positioned.fill(child: screen),
      if (isLandscape)
        Positioned(left: offset, top: 0, bottom: 0, child: Center(child: cutout))
      else
        Positioned(top: offset, left: 0, right: 0, child: Center(child: cutout)),
    ],
  );
}

String _idOf(DeviceInfo info) =>
    '${info.identifier.platform.name}/${info.identifier.name}';

/// Телефоны и планшеты iOS и Android.
List<PreviewDevice> previewDevices() {
  return <PreviewDevice>[
    for (final info in _infos())
      PreviewDevice(
        id: _idOf(info),
        name: info.name,
        isTablet: info.identifier.type == DeviceType.tablet,
        platform: info.identifier.platform,
      ),
  ];
}

/// Устройство по умолчанию: самый новый из привычных iPhone.
String defaultDeviceId() {
  final devices = previewDevices();
  for (final name in <String>['iPhone 17', 'iPhone 16', 'iPhone 13']) {
    for (final device in devices) {
      if (device.name == name) return device.id;
    }
  }
  return devices.first.id;
}

/// [screen] в рамке устройства; рамка вписывается в доступное место.
Widget deviceFrame({
  required String deviceId,
  required bool isLandscape,
  required Widget screen,
}) {
  final infos = _infos();
  final info = infos.firstWhere(
    (item) => _idOf(item) == deviceId,
    orElse: () => infos.first,
  );
  final extra = _extraOf(_idOf(info));
  return DeviceFrame(
    device: info,
    orientation: isLandscape ? Orientation.landscape : Orientation.portrait,
    screen: extra == null ? screen : _withCutout(extra, isLandscape, screen),
  );
}
