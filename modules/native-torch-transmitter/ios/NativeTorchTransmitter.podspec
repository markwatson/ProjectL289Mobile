Pod::Spec.new do |s|
  s.name           = 'NativeTorchTransmitter'
  s.version        = '0.1.0'
  s.summary        = 'High-precision torch transmitter for WOP protocol'
  s.description    = 'Native iOS module for precise LED torch modulation'
  s.author         = ''
  s.homepage       = 'https://github.com/placeholder'
  s.license        = { type: 'MIT' }
  s.platforms      = { ios: '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end
