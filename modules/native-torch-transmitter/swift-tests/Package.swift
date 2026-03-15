// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OffsetCompensationTests",
    targets: [
        .target(
            name: "OffsetCompensation",
            path: "Sources/OffsetCompensation"
        ),
        .testTarget(
            name: "OffsetCompensationTests",
            dependencies: ["OffsetCompensation"],
            path: "Tests/OffsetCompensationTests"
        ),
    ]
)
